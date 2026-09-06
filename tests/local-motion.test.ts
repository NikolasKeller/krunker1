import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { writeFileSync } from 'node:fs';
import { PerspectiveCamera, Vector3 } from 'three';
import { LocalMotion } from '../src/client/local-motion';
import { Network } from '../src/client/network';
import { orientCamera } from '../src/client/camera';
import { CORRECTION_DEADZONE, preserveLocalMotion, smoothCorrection, MAX_CORRECTION_SPEED } from '../src/client/prediction';
import { Room } from './sandyard-room';
import { neutralInput, moveState } from '../src/shared/movement';
import { MAX_IN_FLIGHT_INPUTS, MAX_PENDING_INPUTS } from '../src/shared/protocol';
import { STEP } from '../src/shared/types';
import { ShotClock } from '../src/client/shot-clock';

const reports: unknown[] = [];
after(() => { if (process.env.INPUT_RESPONSE_REPORT) writeFileSync(process.env.INPUT_RESPONSE_REPORT, JSON.stringify(reports, null, 2) + '\n'); });
for (const hz of [60, 144, 240]) test(`${hz} Hz: every render phase responds to movement and aim in one frame with full transport windows`, t => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const net = new Network(); t.after(() => net.disconnect());
    const room = new Room('FRAME'); room.botCount = 0; const actor = room.add('Local', 'hunter', 'blue'); room.start(0);
    net.round = { ...room.round };
    let minDistance = Infinity;
    for (let phase = 0; phase < 100; phase++) {
        net.predicted = { ...actor.state, ...moveState(34, 0, 24) };
        net.seq = 10000; net.predictionHistory.clear(); net.inputs.clear();
        net.inputs.inFlight = Array.from({ length: MAX_IN_FLIGHT_INPUTS }, (_, i) => i + 1);
        for (let i = 0; i < MAX_PENDING_INPUTS; i++) net.inputs.enqueue(neutralInput(i + MAX_IN_FLIGHT_INPUTS + 1));
        const motion = new LocalMotion();
        motion.advance(phase / 100 * STEP, net, neutralInput);
        const before = { ...net.predicted };
        const sample = (seq: number) => ({ ...neutralInput(seq), forward: 1, fire: true, yaw: .4, pitch: -.3 });
        const fireInput = motion.advance(1 / hz, net, sample);
        const visible = motion.preview(net.predicted, sample(net.seq + 1), true)!;
        const distance = Math.hypot(visible.x - before.x, visible.z - before.z);
        minDistance = Math.min(minDistance, distance);
        assert.ok(distance > 0, `phase ${phase}: first frame after key press moves`);
        assert.equal(fireInput.fire, true, 'the same frame receives fire without a send tick');
        const camera = new PerspectiveCamera(); orientCamera(camera, .4, -.3);
        const direction = camera.getWorldDirection(new Vector3());
        assert.ok(Math.abs(direction.x + Math.sin(.4) * Math.cos(-.3)) < 1e-12);
        assert.ok(Math.abs(direction.y - Math.sin(-.3)) < 1e-12, 'local look direction is visible in this frame');
        assert.equal(net.inputs.inFlight.length, MAX_IN_FLIGHT_INPUTS, 'no transport credit was needed');
    }
    reports.push({ renderHz: hz, phasesTested: 100, maxInputToMotionFrames: 1, maxInputToMotionMs: 1000 / hz, minFirstFrameDistanceMetres: minDistance });
});

test('cosmetic disagreements preserve position/velocity and local view while applying health and ammunition', () => {
    const previous = { ...new Room('COSMETIC').add('Local', 'hunter', 'blue').state, ...moveState(34, 0, 24), yaw: 1.2, pitch: -.6 };
    const next = { ...previous, z: previous.z + CORRECTION_DEADZONE * .9, yaw: -2, pitch: 1, hp: 50, ammo: 1 };
    preserveLocalMotion(previous, next);
    assert.equal(next.z, previous.z); assert.equal(next.vz, previous.vz);
    assert.equal(next.yaw, previous.yaw); assert.equal(next.pitch, previous.pitch);
    assert.equal(next.hp, 50); assert.equal(next.ammo, 1);
    const contactChange = { ...previous, y: .04, grounded: false };
    preserveLocalMotion(previous, contactChange);
    assert.equal(contactChange.y, .04, 'gameplay contact changes still reconcile');
    const respawn = { ...previous, life: previous.life + 1, z: previous.z + .03, yaw: -2 };
    preserveLocalMotion(previous, respawn);
    assert.equal(respawn.z, previous.z + .03); assert.equal(respawn.yaw, -2);
});

test('necessary corrections drift at no more than one centimetre per 60 Hz frame and converge', () => {
    const correction = { x: .9, y: .3, z: -.6 };
    const initial = Math.hypot(correction.x, correction.y, correction.z);
    for (let frame = 0; frame < 600; frame++) assert.ok(smoothCorrection(correction, 1 / 60) <= MAX_CORRECTION_SPEED / 60 + 1e-12);
    assert.ok(Math.hypot(correction.x, correction.y, correction.z) < 1e-8);
    assert.ok(initial > 1);
});

test('local firing cadence is independent of ping offset jumps and works through a four-second silence', t => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const net = new Network(); t.after(() => net.disconnect());
    const shots = new ShotClock(), accepted: number[] = [];
    for (let frame = 0; frame <= 600; frame++) {
        const time = frame * 1000 / 60;
        // Emulate successive asymmetric pong estimates, including a large
        // backwards correction just after firing. No server messages are needed.
        net.offset = frame % 30 < 15 ? 4000 : -4000;
        if (shots.fire(time, 100) !== undefined) accepted.push(time);
    }
    assert.ok(accepted.length >= 95);
    for (let i = 1; i < accepted.length; i++) assert.ok(accepted[i] - accepted[i - 1] <= 100 + 1000 / 60 + 1e-8);
    shots.reset(10000, 250); assert.equal(shots.fire(10249, 100), undefined); assert.equal(shots.fire(10250, 100), 0);
});
