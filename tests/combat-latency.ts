import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFile } from 'node:fs/promises';
import { WebSocket } from 'ws';
import { createGameServer } from '../src/server/index';
import { Network } from '../src/client/network';
import { correctedPosition } from '../src/client/prediction';
import { neutralInput, moveState, eyeHeight } from '../src/shared/movement';
import { decodeClientMessage, decodeServerMessage, wireInput } from '../src/shared/protocol';
import { distance, direction, hitPlayer, worldHit } from '../src/shared/math';
import { Scene } from 'three';
import { Effects } from '../src/client/effects';
import { ShotFeedback } from '../src/client/shot-feedback';
import { Controls } from '../src/client/input';
import { assertVisibleWeapon } from './viewmodel-fixture';
import { Viewmodel } from '../src/client/viewmodel';
import { UI } from '../src/client/ui';
import { installDOM } from './dom';
import type { Renderer } from '../src/client/renderer';
import type { Input } from '../src/shared/types';

// Real HTTP/WS server, production Network, input queue, prediction and remote
// interpolation. Only initial placement/health are fixtures. Aiming never reads
// server state; instrumentation observes the exact history lookup used by fire.
const samples = Number(process.env.HIT_SAMPLES ?? 24);
const shotInterval = Number(process.env.HIT_INTERVAL_MS ?? 700);
const profiles = (process.env.HIT_RTTS ?? '0,100,350').split(',').map(Number);
const reports: unknown[] = [];
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * p)] ?? 0;
const stats = (values: number[]) => ({ p50: percentile(values, .5), p95: percentile(values, .95), max: Math.max(0, ...values) });
const wait = async (fn: () => unknown) => {
    const end = performance.now() + 15000;
    while (!fn()) { assert.ok(performance.now() < end, 'join/start timed out'); await delay(5); }
};

for (const rtt of profiles) {
    const app = createGameServer();
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address(); assert.ok(address && typeof address === 'object');
    // Delay control pongs too: the server must measure the impaired link itself.
    class Socket extends WebSocket {
        constructor(url: string, protocol: string) {
            super(url, protocol, { autoPong: false });
            this.on('ping', data => { setTimeout(() => { if (this.readyState === WebSocket.OPEN) this.pong(data); }, rtt); });
        }
    }
    Object.assign(globalThis, { WebSocket: Socket, location: new URL(`http://127.0.0.1:${address.port}`), sessionStorage: { getItem: () => null, setItem() {} } });
    const dom = installDOM(`http://127.0.0.1:${address.port}`);
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: () => null, setItem() {} } });
    const clients = [new Network(), new Network()];
    const rows: Record<string, any>[] = [], aimBySeq = new Map<number, Record<string, any>>();
    let loop: ReturnType<typeof setInterval> | undefined;
    const deliveries: { at: number; run: () => void }[][] = [];
    try {
        const [shooter, runner] = clients;
        let confirmedHits = 0, victimHitEvents = 0, resyncs = 0;
        const ui = new UI(shooter), viewmodel = new Viewmodel(); ui.menu = false;
        const controls = new Controls(document.createElement('canvas')); controls.locked = true;
        const renderer = { viewmodel, project: () => ({ x: 400, y: 300, visible: true }), fps: 144 } as unknown as Renderer;
        let hitSounds = 0;
        const feedback = new ShotFeedback(new Effects(new Scene()), viewmodel, { shot() {}, hit() { hitSounds++; } } as any);
        const switches: Record<string, any>[] = [];
        let switchPending: Record<string, any> | undefined;
        const lethal: Record<string, number> = {};
        let currentSeq = 0;
        // Optional hook is supplied by the candidate; baseline has no hit prediction.
        (feedback as any).onHit = (e: any) => (ui as any).provisionalHit?.(e, renderer, performance.now());
        (feedback as any).onConfirm = (key: string, e: any) => (ui as any).confirmHit(key, e);
        (feedback as any).onRetract = (key: string) => (ui as any).retractHit(key, performance.now());
        shooter.onEvents = events => {
            for (const e of events) {
                if (e.type === 'shot' && e.shooter === shooter.id) {
                    currentSeq = e.seq;
                    const row = rows.find(r => r.seq === e.seq);
                    if (row) row.receivedAt = Date.now();
                    feedback.confirm(e);
                }
                const suppressed = (feedback as any).reconcileEvent?.(e) ?? false;
                if (!suppressed) ui.event(e, renderer, performance.now());
                if (e.type === 'hit' && e.shooter === shooter.id && e.victim === runner.id) { confirmedHits++; if (!suppressed) hitSounds++; }
                if (e.type === 'kill') lethal.killReceivedAt = Date.now();
            }
        };
        (shooter as any).onCombat = (m: any) => (feedback as any).resolve?.(m);
        runner.onEvents = events => { victimHitEvents += events.filter(e => e.type === 'hit' && e.shooter === shooter.id && e.victim === runner.id).length; };
        shooter.connect({ name: 'Aim at rendered opponent', room: '', create: true, classId: 'triggerman', team: 'blue' });
        await wait(() => shooter.local && shooter.round);
        shooter.send({ type: 'configure', bots: 0, duration: 1800000 });
        await wait(() => shooter.players.size === 1);
        runner.connect({ name: 'Moving target', room: shooter.room, classId: 'triggerman', team: 'blue' });
        await wait(() => runner.local && shooter.players.size === 2);
        const room = app.rooms.get(shooter.room)!;
        const actor = room.players.get(shooter.id)!, target = room.players.get(runner.id)!;
        const start = room.start.bind(room);
        room.start = now => {
            start(now);
            // Place the fixture before the new-life snapshot. Teleporting an
            // existing client would leave a cosmetic camera correction offset.
            Object.assign(actor.state, moveState(-28, 0, -2));
            Object.assign(target.state, moveState(-34, 0, -2), { hp: 10000, maxHp: 10000 });
        };
        shooter.send({ type: 'ready', ready: true }); runner.send({ type: 'ready', ready: true });
        await wait(() => clients.every(n => n.round?.phase === 'playing'));
        await wait(() => shooter.predicted?.x === -28 && runner.predicted?.x === -34);
        for (const net of clients) {
            assert.equal(Math.hypot(net.correction.x, net.correction.y, net.correction.z), 0, 'new-life placement has no camera correction debt');
            net.interpolation.reset(); net.frames = [];
            net.maxCorrection = net.maxRawCorrection = net.maxRenderedCorrection = 0;
        }
        const fire = room.fire.bind(room), rewind = room.history.rewind.bind(room.history);
        let active: Record<string, any> | undefined;
        room.history.rewind = (id, time) => {
            const state = rewind(id, time);
            if (active && id === runner.id && state) {
                active.rewindTime = time;
                active.timestampDifferenceMs = time - active.shotTime;
                active.rewoundTarget = { x: state.x, y: state.y, z: state.z };
                active.targetDifferenceMetres = distance(active.renderedTarget, state);
            }
            return state;
        };
        room.fire = (a, input, now) => {
            if (a !== actor) return fire(a, input, now);
            const aim = aimBySeq.get(input.seq); assert.ok(aim, 'every shot has a client render sample');
            active = { ...aim, shotTime: input.shotTime, receivedInterpolationDelay: (input as Input & { interpolationDelay?: number }).interpolationDelay, processedAt: now, serverRtt: a.rtt };
            const before = room.events.length;
            // Change health only for the designated final resolution. Doing it
            // at input time lets the preceding in-flight shot kill the fixture.
            if (aim.lethalFixture) target.state.hp = 1;
            fire(a, input, now);
            const events = room.events.slice(before);
            active.hit = events.some(e => e.type === 'hit' && e.victim === runner.id);
            const shot = events.find(e => e.type === 'shot');
            if (shot?.type === 'shot') active.originDifferenceMetres = distance(aim.cameraOrigin, shot.origin);
            active.resolvedAt = Date.now();
            if (!target.state.alive && !lethal.resolvedAt) lethal.resolvedAt = active.resolvedAt;
            rows.push(active); active = undefined;
        };
        const started = performance.now(), rtts: number[] = [];
        const elapsed = () => performance.now() - started;
        for (const net of clients) {
            const ws = net.ws!, transmit = ws.send.bind(ws), receive = ws.onmessage!;
            let lastUp = 0, lastDown = 0;
            // One FIFO per direction. Independent timers for equal deadlines can
            // reorder coalesced frames, which TCP cannot do.
            const uploads: typeof deliveries[number] = [], downloads: typeof deliveries[number] = [];
            deliveries.push(uploads, downloads);
            ws.send = data => {
                const now = elapsed(); lastUp = Math.max(lastUp, now + rtt / 2);
                const message = decodeClientMessage(data as string | ArrayBuffer | ArrayBufferView);
                if (message.type === 'sync') resyncs++;
                if (net === shooter && message.type === 'input') for (const input of message.inputs) if (input.fire) {
                    const aim = aimBySeq.get(input.seq)!;
                    aim.sentShotTime = input.shotTime;
                    aim.sentAt = Date.now();
                }
                uploads.push({ at: lastUp, run: () => { if (ws.readyState === WebSocket.OPEN) transmit(data); } });
            };
            ws.onmessage = event => {
                const now = elapsed();
                const raw = decodeServerMessage(event.data) as any;
                for (const e of raw.events ?? []) if (e.type === 'shot' && e.shooter === shooter.id && net === shooter) {
                    const row = rows.find(r => r.seq === e.seq); if (row) row.socketAt = Date.now();
                }
                // A reproducible 350 ms downlink stall every 3 s grows the actual
                // adaptive buffer. FIFO delivery models TCP head-of-line blocking.
                const phase = now % 3000;
                const jitter = rtt && phase >= 500 && phase < 600 ? 350 : 0;
                lastDown = Math.max(lastDown, now + rtt / 2 + jitter);
                downloads.push({ at: lastDown, run: () => {
                    const message = decodeServerMessage(event.data);
                    if (net === shooter && message.type === 'pong') rtts.push(Date.now() - message.time);
                    receive.call(ws, event);
                } });
            };
        }
        let accumulator = 0, previous = performance.now(), nextProbe = 0, nextShot = 12000, fired = 0, travel = 1;
        loop = setInterval(() => {
            const time = performance.now(), ms = elapsed(); accumulator += (time - previous) / 1000; previous = time;
            for (const queue of deliveries) while (queue[0]?.at <= ms) queue.shift()!.run();
            const remotes = shooter.remotePlayers(), remote = remotes.find(p => p.id === runner.id);
            (shooter as any).selectWeapon?.(controls.slot, shooter.seq + 1, performance.now());
            if (shooter.predicted && viewmodel.weapon !== shooter.predicted.weapon) viewmodel.setWeapon(shooter.predicted.weapon);
            viewmodel.update(.004, time / 1000, 0, false, 0, shooter.serverNow, 0);
            ui.update(time, renderer, false, remotes);
            if (switchPending && viewmodel.weapon === switchPending.weapon && document.getElementById('hud-weapon')!.textContent === switchPending.name && !switchPending.visibleAt) {
                assertVisibleWeapon(viewmodel);
                switchPending.visibleAt = Date.now(); switchPending.delayMs = switchPending.visibleAt - switchPending.pressedAt;
                switches.push(switchPending); switchPending = undefined;
            }
            if (lethal.resolvedAt && remote && !remote.alive && !lethal.opponentHiddenAt) lethal.opponentHiddenAt = Date.now();
            if (lethal.resolvedAt && document.getElementById('killfeed')!.textContent && !lethal.feedVisibleAt) lethal.feedVisibleAt = Date.now();
            runner.remotePlayers();
            while (accumulator >= 1 / 60) {
                accumulator -= 1 / 60;
                const p = runner.predicted!;
                if (p.z < -8) travel = -1; else if (p.z > 3) travel = 1;
                runner.input({ ...neutralInput(++runner.seq), forward: travel, shotTime: runner.serverNow, aim: true });
                const input = neutralInput(++shooter.seq);
                input.aim = true; input.slot = controls.slot;
                if ((shooter as any).weapons) input.combat = true;
                input.shotTime = shooter.interpolation.playbackTime ?? shooter.serverNow - shooter.interpolationDelay;
                if (remote) {
                    const view = correctedPosition(shooter.predicted!, shooter.correction);
                    const origin = { x: view.x, y: view.y + eyeHeight(shooter.predicted!), z: view.z };
                    const dx = remote.x - origin.x, dz = remote.z - origin.z, dy = remote.y + 1.03 - origin.y;
                    input.yaw = Math.atan2(-dx, -dz); input.pitch = Math.atan2(dy, Math.hypot(dx, dz));
                    if (ms >= nextShot && fired < samples && shooter.predicted!.ammo > 0 && shooter.predicted!.reloadEnd <= shooter.serverNow && (!(shooter as any).weapons || (shooter as any).weapons.preview(shooter.predicted!, input).steps >= (shooter as any).weapons.preview(shooter.predicted!, input).next)) {
                        const ray = direction(input.yaw, input.pitch), hit = hitPlayer(origin, ray, remote);
                        assert.ok(hit && hit.distance < worldHit(origin, ray), 'crosshair intersects the rendered body without a wall');
                        input.fire = true; fired++; nextShot = ms + shotInterval;
                        const beforeNumbers = document.getElementById('damage-numbers')!.children.length;
                        const predictedAt = performance.now();
                        const clock = (shooter as any).weapons?.preview(shooter.predicted!, input);
                        const index = clock?.fire() ?? 0;
                        (feedback.fire as any)({ ...shooter.predicted!, bloom: clock?.bloom ?? shooter.predicted!.bloom }, wireInput({ ...input, life: shooter.predicted!.life }), index, clock?.aim ?? 1, origin, remotes, shooter.round!.mode, shooter.serverNow);
                        const predictedHit = document.getElementById('damage-numbers')!.children.length > beforeNumbers;
                        (input as any).__predicted = { predictedHit, predictionMs: performance.now() - predictedAt };
                        aimBySeq.set(input.seq, { ...(input as any).__predicted, lethalFixture: fired === samples, seq: input.seq, renderTime: shooter.interpolation.playbackTime, shotTime: input.shotTime, firedAt: Date.now(), renderedAt: shooter.serverNow, interpolationDelay: shooter.serverNow - input.shotTime, reserve: shooter.interpolation.reserve, cameraOrigin: origin, renderedTarget: { x: remote.x, y: remote.y, z: remote.z }, clientPing: shooter.ping });
                    }
                }
                if (shooter.predicted!.ammo === 0) input.reload = true;
                shooter.input(wireInput(input));
            }
            if (ms >= nextProbe) { for (const net of clients) net.send({ type: 'ping', time: Date.now() }); nextProbe += 250; }
        }, 4);
        await waitForShots();
        await wait(() => confirmedHits === rows.filter(r => r.hit).length && victimHitEvents === confirmedHits && lethal.opponentHiddenAt);
        for (const slot of [2, 3, 1, 2, 1, 3] as const) {
            const { WEAPONS } = await import('../src/shared/weapons');
            const weapon = slot === 1 ? 'rifle' : slot === 2 ? 'pistol' : 'knife';
            switchPending = { slot, weapon, name: WEAPONS[weapon].name, pressedAt: Date.now() };
            document.body.dispatchEvent(new window.KeyboardEvent('keydown', { code: `Digit${slot}`, bubbles: true }));
            await wait(() => !switchPending);
            await delay(700);
        }
        async function waitForShots() {
            const deadline = performance.now() + 12000 + samples * shotInterval + Math.ceil(samples / 30) * 3000 + 15000;
            while (rows.length < samples && performance.now() < deadline) await delay(20);
        }
        const report = { shotInterval, resolutionToReceiptMs: stats(rows.map(r => r.receivedAt - r.resolvedAt)), resolutionToSocketMs: stats(rows.map(r => r.socketAt - r.resolvedAt)), inputToReceiptMs: stats(rows.map(r => r.receivedAt - r.firedAt)), prediction: (feedback as any).metrics ?? { supported: false }, hitSounds, provisionalHits: rows.filter(r => r.predictedHit).length, provisionalMs: stats(rows.filter(r => r.predictedHit).map(r => r.predictionMs)), weaponVisibleMs: stats(switches.map(r => r.delayMs)), switches, death: { ...lethal, resolutionToKillMs: lethal.killReceivedAt - lethal.resolvedAt, killToOpponentHiddenMs: lethal.opponentHiddenAt - lethal.killReceivedAt, killToFeedMs: lethal.feedVisibleAt - lethal.killReceivedAt }, rtt, samples, actualShots: rows.length, hits: rows.filter(r => r.hit).length, confirmedHits, victimHitEvents, resyncs, hitRate: rows.filter(r => r.hit).length / samples, probeRttMs: stats(rtts), timestampDifferenceMs: stats(rows.map(r => r.timestampDifferenceMs)), targetDifferenceMetres: stats(rows.map(r => r.targetDifferenceMetres)), maxCorrectionMetres: Math.max(...clients.map(n => n.maxCorrection)), maxSnapshotJumpMetres: Math.max(...clients.map(n => n.maxRenderedCorrection)), shots: rows };
        reports.push(report);
        console.log(JSON.stringify({ ...report, shots: undefined }));
        if (process.env.COMBAT_REPORT) await writeFile(process.env.COMBAT_REPORT, JSON.stringify(reports, null, 2) + '\n');
    } finally {
        if (loop) clearInterval(loop);
        clients.forEach(n => n.disconnect());
        await app.close(); dom.restore();
    }
}
if (process.env.COMBAT_REPORT) await writeFile(process.env.COMBAT_REPORT, JSON.stringify(reports, null, 2) + '\n');
for (const report of reports as { rtt: number; hits: number; actualShots: number; resyncs: number; maxCorrectionMetres: number; maxSnapshotJumpMetres: number; resolutionToSocketMs: { max: number }; weaponVisibleMs: { max: number }; provisionalMs: { max: number }; prediction: { compared?: number; disagreements?: number }; provisionalHits: number }[]) {
    if (report.prediction.compared !== undefined) {
        assert.equal(report.prediction.compared, samples, 'every predicted hit or miss is resolved');
        assert.equal(report.prediction.disagreements, 0, 'prediction agrees including target, zone and damage');
        assert.equal(report.provisionalHits, samples, 'aimed shots have immediate provisional feedback');
        assert.ok(report.resolutionToSocketMs.max < 1000 / 60, 'confirmation bypasses the snapshot cadence');
        assert.ok(report.weaponVisibleMs.max < 1000 / 60, 'visible weapon/HUD within a 60 Hz frame');
        assert.ok(report.provisionalMs.max < 1000 / 60, 'provisional feedback within a 60 Hz frame');
    }
    assert.equal(report.resyncs, 0, 'the impaired TCP stream remains ordered');
    assert.equal(report.actualShots, samples, `all shots reach authority at ${report.rtt} ms RTT`);
    assert.equal(report.maxCorrectionMetres, 0, 'local movement correction remains zero');
    assert.equal(report.maxSnapshotJumpMetres, 0, 'snapshot camera correction remains zero');
    assert.equal(report.hits, samples, `aiming at the rendered opponent must hit at ${report.rtt} ms RTT`);
}
