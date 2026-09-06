import assert from 'node:assert/strict';
import test, { after, type TestContext } from 'node:test';
import { writeFileSync } from 'node:fs';
import { Network } from '../src/client/network';
import { previewInput, MAX_CORRECTION_SPEED } from '../src/client/prediction';
import { Room } from '../src/server/simulation';
import { moveState, neutralInput } from '../src/shared/movement';
import { decodeClientMessage, encodeServerMessage, MAX_IN_FLIGHT_INPUTS, MAX_PENDING_INPUTS } from '../src/shared/protocol';
import { STEP, type ClientMessage, type ServerMessage } from '../src/shared/types';

// Exercise the production Network, binary codec and authoritative simulation on
// a deterministic link. No browser, simplified predictor or real-time sleeps.
class Link {
    static OPEN = 1;
    readyState = 1;
    bufferedAmount = 0;
    onmessage?: (e: { data: string | Uint8Array }) => void;
    sent: ClientMessage[] = [];
    send(data: string | Uint8Array) { this.sent.push(decodeClientMessage(data)); }
    close() { this.readyState = 3; }
}
function connect(t: TestContext) {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    for (const [key, value] of Object.entries({ WebSocket: Link, location: { protocol: 'http:', host: 'stall.test' }, sessionStorage: { getItem: () => null, setItem: () => {} } })) {
        const previous = Object.getOwnPropertyDescriptor(globalThis, key);
        Object.defineProperty(globalThis, key, { configurable: true, value });
        t.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else Reflect.deleteProperty(globalThis, key); });
    }
    const net = new Network();
    net.connect({ name: 'Walker', room: '', classId: 'hunter', team: 'blue' });
    t.after(() => net.disconnect());
    return { net, link: net.ws as unknown as Link };
}
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * p)] ?? 0;
const distribution = (values: number[]) => ({ p50: percentile(values, .5), p95: percentile(values, .95), max: Math.max(0, ...values) });
const reports: unknown[] = [];
after(() => { if (process.env.MOVEMENT_REPORT) writeFileSync(process.env.MOVEMENT_REPORT, JSON.stringify(reports, null, 2) + '\n'); });

for (const stallSeconds of [1, 2]) for (const mode of ['blocked socket', 'hidden TCP queue', 'upload only'] as const) {
    test(`${stallSeconds}s ${mode}: prediction advances at 144 FPS and recovery never snaps the camera`, t => {
        const { net, link } = connect(t);
        const room = new Room('STALL'); room.botCount = 0;
        const actor = room.add('Walker', 'hunter', 'blue'); room.start(0);
        Object.assign(actor.state, moveState(34, 0, 24)); actor.lastInputAt = 0;
        let snapshot = 0, tick = 0, accumulator = 0;
        const heldUploads: Extract<ClientMessage, { type: 'input' }>[] = [], heldDownloads: ServerMessage[] = [];
        const raw: number[] = [], visible: number[] = [], stallSteps: number[] = [], stallFrames: number[] = [];
        let maxSnapshotJump = 0, stallStartZ = 0, stallEndZ = 0;
        const camera = () => ({ x: net.predicted!.x + net.correction.x, y: net.predicted!.y + net.correction.y, z: net.predicted!.z + net.correction.z });
        const receive = (m: ServerMessage) => {
            const before = net.predicted && { ...net.predicted }, oldView = before && camera();
            link.onmessage?.({ data: encodeServerMessage(m, actor.state.id) });
            if (before && m.type === 'snapshot') {
                raw.push(Math.hypot(before.x - net.predicted!.x, before.y - net.predicted!.y, before.z - net.predicted!.z));
                const view = camera();
                maxSnapshotJump = Math.max(maxSnapshotJump, Math.hypot(oldView!.x - view.x, oldView!.y - view.y, oldView!.z - view.z));
            }
        };
        const makeSnapshot = (): ServerMessage => ({ type: 'snapshot', n: ++snapshot, base: 0, full: true, time: tick * STEP * 1000, players: [{ ...actor.state }], removed: [], round: { ...room.round } });
        receive({ type: 'welcome', id: actor.state.id, room: room.id, host: actor.state.id, token: 'session', serverTime: Date.now() });
        receive(makeSnapshot());
        let lastView = net.predicted!.z;
        const stallEnd = 60 + stallSeconds * 60;
        for (let frame = 1; frame <= (stallSeconds + 7) * 144; frame++) {
            accumulator += 1 / 144;
            while (accumulator + 1e-12 >= STEP) {
                accumulator = Math.max(0, accumulator - STEP); tick++;
                const stalled = tick > 60 && tick <= stallEnd;
                if (tick === 61) stallStartZ = net.predicted!.z;
                link.bufferedAmount = stalled && mode !== 'hidden TCP queue' ? 100 : 0;
                const before = net.predicted!.z;
                net.input({ ...neutralInput(++net.seq), forward: tick <= stallEnd ? 1 : 0 });
                if (stalled) stallSteps.push(before - net.predicted!.z);
                if (tick === stallEnd) stallEndZ = net.predicted!.z;
                net.inputs.flush(link, tick * STEP * 1000);
                for (const m of link.sent.splice(0)) if (m.type === 'input') heldUploads.push(m);
                if (!stalled) {
                    for (const m of heldUploads.splice(0)) assert.ok(room.enqueue(actor, m.inputs, tick * STEP * 1000));
                    for (const m of heldDownloads.splice(0)) receive(m);
                }
                room.tick(tick * STEP * 1000);
                if (tick % 3 === 0) {
                    const m = makeSnapshot();
                    if (stalled && mode !== 'upload only') heldDownloads.push(m); else receive(m);
                }
                assert.ok(net.inputs.inFlight.length <= MAX_IN_FLIGHT_INPUTS);
                assert.ok(net.outgoing.length <= MAX_PENDING_INPUTS);
            }
            visible.push(net.smoothCorrection(1 / 144));
            const rendered = previewInput(net.predicted, { ...neutralInput(net.seq + 1), forward: tick < stallEnd ? 1 : 0 }, true, accumulator / STEP)!;
            const view = rendered.z + net.correction.z;
            if (tick > 62 && tick < stallEnd - 1) stallFrames.push(lastView - view);
            lastView = view;
        }
        const report = { stallSeconds, mode, renderHz: 144, stallDistanceMetres: stallStartZ - stallEndZ, minSimulationStepMetres: Math.min(...stallSteps), minRenderStepMetres: Math.min(...stallFrames), maxSnapshotJumpMetres: maxSnapshotJump, rawCorrectionMetres: distribution(raw), visibleCorrectionMetres: distribution(visible), correctionsOver1cm: raw.filter(x => x > .01).length, residualCorrectionMetres: Math.hypot(net.correction.x, net.correction.y, net.correction.z) };
        reports.push(report);
        assert.ok(report.stallDistanceMetres > stallSeconds * 9, JSON.stringify(report));
        assert.ok(stallSteps.every(distance => distance > .15), 'every 60 Hz step advances, even when either transport window is full');
        assert.ok(stallFrames.every(distance => distance > .005 && distance < .12), 'every 144 Hz frame moves continuously, bounded by walking plus correction speed');
        assert.ok(maxSnapshotJump < 1e-9, 'receiving authority, including a backlog of snapshots, cannot teleport the camera');
        assert.ok(report.visibleCorrectionMetres.max <= MAX_CORRECTION_SPEED / 144 + 1e-9, 'recovery correction stays below 0.42 cm per render frame (1 cm at 60 FPS)');
        assert.ok(report.residualCorrectionMetres < .001, 'smoothing converges instead of hiding a permanent divergence');
        assert.ok(Math.hypot(net.predicted!.x - actor.state.x, net.predicted!.y - actor.state.y, net.predicted!.z - actor.state.z) < .001, 'prediction returns to authority after recovery');
    });
}

test('a key press is visible before the next physics or send tick without mutating prediction', t => {
    const { net } = connect(t), room = new Room('PREVIEW');
    net.predicted = { ...room.add('Walker', 'hunter', 'blue').state, ...moveState(34, 0, 24) };
    const before = { ...net.predicted };
    const preview = previewInput(net.predicted, { ...neutralInput(1), forward: 1 }, true, (1 / 144) / STEP)!;
    assert.ok(preview.z < before.z);
    assert.deepEqual(net.predicted, before);
    assert.equal(net.inputs.pending.length, 0);
});
