import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteInterpolation, MAX_EXTRAPOLATION_METRES, type RemoteFrame } from '../src/client/interpolation';
import { runRemoteSession, type RemoteProfile } from './remote-session';
import { Room } from './sandyard-room';
import { moveState } from '../src/shared/movement';

for (const profile of ['stable', 'matched-quantiles', 'one-second-stalls', 'four-second-blackout'] as RemoteProfile[]) {
    for (const hz of [60, 144]) test(`${profile}, ${hz} Hz: jittered/late/dropped states never jump and the buffer recovers`, () => {
        const report = runRemoteSession(profile, hz, true);
        // This fixture peaks at 5.4 m/s. At 60 Hz 9 cm is ordinary
        // movement; 15 cm allows 5 cm correction plus playback rate adjustment.
        assert.ok(report.renderStepMetres.max <= .15 * 60 / hz + 1e-8, JSON.stringify(report));
        assert.ok(report.recoveryStepMetres.max <= .15 * 60 / hz + 1e-8);
        if (profile !== 'four-second-blackout') {
            assert.equal(report.exhaustedRunwayEpisodes, 0);
            assert.equal(report.freezeFrames, 0);
            assert.equal(report.underrunsAfter30Seconds, 0, 'no repeated underruns after learning the link');
        } else assert.ok(report.exhaustedRunwayEpisodes <= 1, 'only the deliberate four-second outage exhausts extrapolation');
    });
}

const player = () => ({ ...new Room('BOUNDED').add('Target', 'triggerman', 'red').state, ...moveState(34, 0, 20), vz: -10 });
test('ordinary batched movement stays on the exact historical segment used by lag compensation', () => {
    const interpolation = new RemoteInterpolation(), p = player();
    // Three movement commands may span 33 ms of snapshot time, despite a
    // 10 m/s endpoint velocity. Limiting this to endpoint velocity accumulated
    // a half-metre render error and caused an aimed WebSocket shot to miss.
    const frames = [0, 33, 100, 133].map((time, n) => ({ time, players: new Map([[p.id, { ...p, z: 20 - n * .5 }]]) }));
    for (let now = 100; now <= 230; now += 4) {
        const time = now - 100, a = frames.filter(f => f.time <= time).at(-1)!, b = frames.find(f => f.time >= time)!;
        const t = (time - a.time) / (b.time - a.time || 1);
        const expected = a.players.get(p.id)!.z + (b.players.get(p.id)!.z - a.players.get(p.id)!.z) * t;
        const state = interpolation.sample(frames, '', now, now, 0)[0];
        assert.ok(Math.abs(state.z - expected) < 1e-8);
    }
});
test('one-second silence extrapolates; distance/time caps stop a disconnect, including animation', () => {
    const interpolation = new RemoteInterpolation(), p = player();
    const frames: RemoteFrame[] = [{ time: 0, players: new Map([[p.id, p]]) }];
    interpolation.sample(frames, '', 100, 100, 0);
    let state = p;
    for (let now = 116; now <= 5000; now += 16) {
        const previous = state;
        state = interpolation.sample(frames, '', now, now, 0)[0];
        assert.ok(p.z - state.z <= Math.min(MAX_EXTRAPOLATION_METRES, 12.5) + 1e-8);
        if (now <= 1100) assert.ok(state.z < previous.z, 'keeps moving throughout a one-second state gap');
    }
    assert.equal(state.vz, 0, 'animation stops with the capped mesh');
    assert.ok(Math.abs(state.z - 7.5) < 1e-6);
    const fast = { ...p, vz: -1000 }, cap = new RemoteInterpolation();
    for (let now = 100; now < 5000; now += 16) {
        const q = cap.sample([{ time: 0, players: new Map([[p.id, fast]]) }], '', now, now, 0)[0];
        assert.ok(Math.abs(q.z - fast.z) <= MAX_EXTRAPOLATION_METRES + 1e-8);
    }
});

test('catch-up bursts, clock shifts and collisions cannot relocate an already visible player', () => {
    const interpolation = new RemoteInterpolation(), p = { ...player(), vz: 0 };
    let frames = [{ time: 0, players: new Map([[p.id, p]]) }];
    let last = interpolation.sample(frames, '', 100, 100, 0)[0];
    // Both endpoints are legal but lie on opposite sides of several buildings.
    // The previous target-origin collision sweep could jump to their far side.
    frames = [{ time: 2000, players: new Map([[p.id, { ...p, x: -34, z: -20 }]]) }];
    const sameFrame = interpolation.sample(frames, '', 2100, 100, 2000)[0];
    assert.deepEqual([sameFrame.x, sameFrame.z], [last.x, last.z], 'zero render time means zero displacement');
    for (let now = 116; now <= 5000; now += 16) {
        const q = interpolation.sample(frames, '', now + 100000, now, 350)[0];
        assert.ok(Math.hypot(q.x - last.x, q.y - last.y, q.z - last.z) <= .048 + 1e-8);
        assert.ok(Math.abs(q.vx - (q.x - last.x) / .016) < 1e-7);
        last = q;
    }
});

test('new lives spawn once, then stay on the bounded path while old-life history plays out', () => {
    const interpolation = new RemoteInterpolation(), p = player(); interpolation.reserve = 2000;
    const frames: RemoteFrame[] = [{ time: 0, players: new Map([[p.id, p]]) }];
    interpolation.sample(frames, '', 1000, 1000, 350);
    const spawned = { ...p, life: p.life + 1, z: 0 };
    frames.push({ time: 1100, players: new Map([[p.id, spawned]]) });
    let last = interpolation.sample(frames, '', 1100, 1100, 350)[0];
    assert.equal(last.life, spawned.life); assert.equal(last.z, 0);
    for (let now = 1116; now < 4000; now += 16) {
        if (now % 4 === 0) frames.push({ time: now, players: new Map([[p.id, { ...spawned, z: -(now - 1100) / 100 }]]) });
        if (frames.length > 64) frames.shift();
        const state = interpolation.sample(frames, '', now, now, 350)[0];
        assert.equal(state.life, spawned.life);
        assert.ok(Math.abs(state.z - last.z) <= .224 + 1e-8);
        last = state;
    }
    assert.deepEqual(interpolation.sample([{ time: 5000, players: new Map() }], '', 5000, 5000, 350), []);
});
