import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteInterpolation, MAX_EXTRAPOLATION_MS, type RemoteFrame } from '../src/client/interpolation';
import { Room } from './sandyard-room';
import { moveState } from '../src/shared/movement';
import { UI } from '../src/client/ui';
import type { Network } from '../src/client/network';
import type { Renderer } from '../src/client/renderer';
import { installDOM } from './dom';

const player = () => ({ ...new Room('REMOTE').add('Runner', 'triggerman', 'red').state, ...moveState(34, 0, 20), vz: -2 });
test('jitter buffer grows on late delivery and shrinks slowly with hysteresis after calm traffic', () => {
    const interpolation = new RemoteInterpolation();
    for (let time = 0; time < 2000; time += 50) interpolation.observe(time, time + 175);
    assert.equal(interpolation.reserve, 100); assert.equal(interpolation.delay(350), 275);
    interpolation.observe(2000, 2600);
    assert.equal(interpolation.reserve, 525);
    interpolation.observe(2050, 2601);
    assert.equal(interpolation.reserve, 525, 'a quick arrival does not immediately shrink it');
    for (let time = 2100; time <= 60000; time += 50) interpolation.observe(time, Math.max(2602, time + 175));
    assert.ok(interpolation.reserve <= 125 && interpolation.reserve >= 100);
});

test('late and dropped snapshots advance smoothly, with capped extrapolation and blended recovery', () => {
    const interpolation = new RemoteInterpolation(), frames: RemoteFrame[] = [], p = player();
    const deliveries: { time: number; arrival: number }[] = [];
    let lastArrival = 0;
    for (let time = 0; time <= 12000; time += 50) {
        if (time % 850 === 0 && time > 0) continue;
        // 350 ms baseline RTT, common jitter, and >1 s RTT tail bursts.
        const jitter = time % 2000 === 0 && time > 0 ? 450 : [0, 20, 60, 0, 35][time / 50 % 5];
        lastArrival = Math.max(lastArrival + 1, time + 175 + jitter);
        deliveries.push({ time, arrival: lastArrival });
    }
    let previous: ReturnType<typeof player> | undefined, smoothSteps = 0, freezes = 0, maximum = 0;
    for (let now = 0; now < 13000; now += 1000 / 60) {
        while (deliveries[0]?.arrival <= now) {
            const d = deliveries.shift()!;
            interpolation.observe(d.time, d.arrival);
            frames.push({ time: d.time, players: new Map([[p.id, { ...p, z: 20 - d.time * .002, hp: d.time < 6000 ? 100 : 50 }]]) });
            if (frames.length > 64) frames.shift();
        }
        const state = interpolation.sample(frames, '', now, now, 350)[0];
        if (state && previous && now > 1000 && now < 12000) {
            const advance = previous.z - state.z;
            maximum = Math.max(maximum, Math.abs(advance));
            if (advance > 1e-5) smoothSteps++;
            else {
                freezes++;
                assert.ok(interpolation.playbackTime! - frames.at(-1)!.time >= MAX_EXTRAPOLATION_MS, 'never freeze while interpolation or extrapolation has runway');
            }
            assert.ok(advance >= -1e-6, `playback reversed at ${now}: ${advance}`);
            assert.equal(state.hp, frames.at(-1)!.players.get(p.id)!.hp, 'health bypasses position playback');
        }
        previous = state;
    }
    assert.ok(smoothSteps > 630 && freezes <= 6, `${smoothSteps} advances, ${freezes} freezes`);
    assert.ok(maximum < .12, `maximum render step ${maximum}`);
    const latest = frames.at(-1)!.players.get(p.id)!;
    // Continue rendering after disconnect. A long gap between render calls must
    // also blend, rather than completing a correction in a single frame.
    for (let now = 13000; now < 30000; now += 1000 / 60) interpolation.sample(frames, '', now, now, 350);
    const stopped = interpolation.sample(frames, '', 30000, 30000, 350)[0];
    assert.ok(latest.z - stopped.z <= 2 * MAX_EXTRAPOLATION_MS / 1000 + 1e-9);
    const again = interpolation.sample(frames, '', 40000, 40000, 350)[0];
    assert.ok(Math.abs(stopped.z - again.z) < .001, 'a disconnected player stops at the cap');
});

test('nameplate position and health use exactly the body sample on every render frame', () => {
    const env = installDOM();
    try {
        const room = new Room('TAGS'); room.botCount = 0; room.start(0);
        const local = { ...room.add('You', 'hunter', 'blue').state, ...moveState(34, 0, 24) }, remote = player();
        const net = { id: local.id, host: local.id, room: room.id, status: 'CONNECTED', round: room.round, players: new Map([[local.id, local], [remote.id, remote]]), local, predicted: local, serverNow: 1000, ping: 350, difficulty: 'normal', bots: 0, remotePlayers() { throw Error('must not resample separately from the body'); }, send() {} } as unknown as Network;
        const ui = new UI(net); ui.menu = false;
        const renderer = { fps: 60, viewmodel: { aim: 0 }, project: (p: { x: number; y: number; z: number }) => ({ x: p.x * 10, y: p.z * 10, visible: true }) } as unknown as Renderer;
        const interpolation = new RemoteInterpolation();
        const frames = [0, 50].map(time => ({ time, players: new Map([[remote.id, { ...remote, z: 20 - time * .002, hp: time ? 50 : 100 }]]) }));
        let previousTag: HTMLElement | undefined;
        for (const now of [110, 120, 130, 140]) {
            const body = interpolation.sample(frames, local.id, now, now, 0);
            ui.update(now, renderer, false, body);
            const tag = document.querySelector<HTMLElement>('.nameplate')!;
            assert.ok(tag); assert.equal(parseFloat(tag.style.top), body[0].z * 10);
            if (previousTag) assert.equal(tag, previousTag, 'render frames retain the DOM node');
            previousTag = tag;
            assert.equal(parseFloat(tag.querySelector<HTMLElement>('b')!.style.width), body[0].hp);
            assert.equal(body[0].hp, 50, 'latest health is immediate even while position is interpolated');
        }
    } finally { env.restore(); }
});

test('extrapolation stops at solids, respawns reset blending, and removals discard tracks', () => {
    const interpolation = new RemoteInterpolation(), p = { ...player(), x: -19, z: -5.5, vz: -28 };
    let frames = [{ time: 0, players: new Map([[p.id, p]]) }];
    interpolation.sample(frames, '', 100, 100, 0);
    const clipped = interpolation.sample(frames, '', 300, 300, 0)[0];
    assert.ok(clipped.z >= -5.62 - 1e-9);
    frames = [{ time: 400, players: new Map([[p.id, { ...p, life: p.life + 1, x: 34, z: 20, vz: 0 }]]) }];
    const spawned = interpolation.sample(frames, '', 500, 500, 0)[0];
    assert.equal(spawned.x, 34); assert.equal(spawned.z, 20);
    assert.deepEqual(interpolation.sample([{ time: 450, players: new Map() }], '', 550, 550, 0), []);
});
