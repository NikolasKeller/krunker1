import test from 'node:test';
import assert from 'node:assert/strict';
import { SOLID_BOXES, RAMPS, BOXES, type MapBox } from '../src/shared/map';
import { move, moveState, neutralInput, MAX_SPEED, RADIUS, HEIGHT } from '../src/shared/movement';
import { clipPlayerMotion } from '../src/shared/collision';
import { correctedPosition, predictInput, reconcile, previewInput } from '../src/client/prediction';
import { Room } from '../src/server/simulation';
import { STEP } from '../src/shared/types';
import { wireInput } from '../src/shared/protocol';

function isolated(body: (boxes: MapBox[]) => void) {
    const boxes = [...SOLID_BOXES], ramps = [...RAMPS];
    SOLID_BOXES.length = 0; RAMPS.length = 0;
    try { body(boxes); } finally { SOLID_BOXES.splice(0, SOLID_BOXES.length, ...boxes); RAMPS.push(...ramps); }
}
function inside(p: { x: number; y: number; z: number; slide: number }, b: MapBox) {
    return Math.abs(p.x - b.x) < b.w / 2 + RADIUS - 1e-8 && Math.abs(p.z - b.z) < b.d / 2 + RADIUS - 1e-8 &&
        p.y < b.y + b.h / 2 - 1e-8 && p.y + (p.slide > 0 ? 1.26 : HEIGHT) > b.y - b.h / 2 + 1e-8;
}
test('maximum-speed movement cannot cross a thin collider in one tick (entry-side regression)', () => isolated(() => {
    SOLID_BOXES.push({ x: 32, y: 2, z: 18, w: .15, h: 4, d: 4, color: 0 });
    const p = { ...moveState(31.544, 0, 18), vx: MAX_SPEED, grounded: false };
    move(p, neutralInput());
    assert.ok(p.x <= 31.545 + 1e-9, `crossed thin wall: ${p.x}`);
}));

test('straight walking at a real building contact never ejects the player across the other face', () => {
    const p = moveState(-28.38, 0, -13);
    // Packet yaw is float32. The old resolver reached x=-26.38 on tick 15,
    // misread its rounded contact as penetration, then teleported z to -5.62.
    for (let seq = 1; seq <= 120; seq++) {
        const before = { ...p };
        move(p, wireInput({ ...neutralInput(seq), forward: 1, yaw: -Math.PI / 2 }));
        assert.ok(Math.hypot(p.x - before.x, p.z - before.z) <= MAX_SPEED * STEP + 1e-9, `unphysical displacement at tick ${seq}`);
        assert.ok(Math.abs(p.z + 13) < 1e-5, `sideways ejection at tick ${seq}: ${p.z}`);
        assert.ok(p.x <= -26.38 + 1e-9);
    }
    assert.equal(p.x, -26.38);
});

test('walking into the yard crate stops instead of ejecting sideways into the speed-test lane', () => {
    const p = moveState(32, 0, 30);
    for (let seq = 1; seq <= 60; seq++) move(p, { ...neutralInput(seq), forward: 1 });
    assert.equal(p.x, 32);
    assert.equal(p.z, 28.88);
    assert.equal(p.vz, 0);
});

test('every solid map box blocks maximum-speed air, slide and hop approaches on both axes and several angles', () => isolated(boxes => {
    let checks = 0, fastest = 0;
    for (const original of boxes) for (const axis of ['x', 'z'] as const) for (const sign of [-1, 1])
        for (const angle of [-Math.PI / 3, -.35, 0, .35, Math.PI / 3]) for (const mode of ['air', 'slide', 'hop']) for (const dt of [STEP, .05]) {
            // Translate one real collider into an unobstructed fixture, preserving
            // all dimensions. Separate assembled-map checks below cover joints.
            const b = { ...original, x: 0, z: 0 };
            const half = (axis === 'x' ? b.w : b.d) / 2, other = axis === 'x' ? 'z' : 'x';
            b[axis] = sign * half; SOLID_BOXES.splice(0, SOLID_BOXES.length, b);
            const p = moveState(0, Math.max(0, b.y - b.h / 2 - .5), 0);
            p[axis] = -sign * (RADIUS + .001);
            p.grounded = mode !== 'air'; p.groundTime = 0;
            p[axis === 'x' ? 'vx' : 'vz'] = sign * MAX_SPEED * Math.cos(angle);
            p[other === 'x' ? 'vx' : 'vz'] = MAX_SPEED * Math.sin(angle);
            const i = { ...neutralInput(), slide: mode !== 'air', jump: mode === 'hop' };
            // Verify movement actually reaches the hard cap after stacked boosts.
            if (mode === 'hop') {
                const free = { ...p, x: 34, z: 34 }; SOLID_BOXES.length = 0; move(free, i); SOLID_BOXES.push(b); fastest = Math.max(fastest, Math.hypot(free.vx, free.vz));
            }
            move(p, i, 1.12 * 1.16, dt);
            assert.equal(inside(p, b), false, JSON.stringify({ original, axis, sign, angle, mode, dt, p }));
            assert.ok(p[axis] * sign <= -RADIUS + 1e-8, `far side: ${JSON.stringify({ original, axis, sign, mode, dt, p })}`);
            checks++;
        }
    assert.ok(fastest >= MAX_SPEED - 1e-9, `tested actual cap ${fastest}`);
    assert.ok(checks > 6000);
}));

test('solid lamp posts block movement and camera corrections cannot cross a building or ramp', () => {
    const p = { ...moveState(-32.456, 0, 18), vx: MAX_SPEED, grounded: false };
    move(p, neutralInput()); assert.ok(p.x <= -32.455 + 1e-9);
    const room = new Room('COLLISION'); room.botCount = 0;
    const state = { ...room.add('Walker', 'hunter', 'blue').state, ...moveState(-19, 0, -5.5) };
    const view = correctedPosition(state, { x: 0, y: 0, z: -20 });
    assert.ok(view.z >= -6 + RADIUS - 1e-9);
    const ramp = clipPlayerMotion({ x: -10, y: 0, z: -8 }, { x: -10, y: 0, z: 8 });
    assert.ok(ramp.z <= -3.5 - RADIUS + 1e-9);
    const tangent = clipPlayerMotion({ x: -12 + RADIUS, y: 0, z: -12 }, { x: -12 + RADIUS, y: 0, z: -10 });
    assert.equal(tangent.z, -10, 'touching a wall still permits tangent motion');
});

test('assembled wall joints, door faces, boundary corners and ramp sides stay solid during slide hops', () => {
    const starts = [
        [-19, 0, -5.5, 0], [-11.5, 0, -13, Math.PI / 2],
        [36.5, 0, 36.5, -Math.PI * .75], [-36.5, 0, -36.5, Math.PI * .25],
        [-10, 0, -4.5, Math.PI], [10, 0, 4.5, 0], [-4.5, 0, 10, -Math.PI / 2],
        [4.6, 0, -10.5, 0], [0, 0, -9, Math.PI / 2],
    ];
    for (const [x, y, z, yaw] of starts) {
        const p = moveState(x, y, z);
        for (let tick = 0; tick < 180; tick++) {
            p.vx = -Math.sin(yaw) * MAX_SPEED; p.vz = -Math.cos(yaw) * MAX_SPEED;
            move(p, { ...neutralInput(tick), yaw, forward: 1, jump: tick % 8 === 0, slide: tick % 8 < 4 });
            for (const b of SOLID_BOXES) assert.equal(inside(p, b), false, `tick ${tick}: ${JSON.stringify({ p, b })}`);
            assert.ok(Math.abs(p.x) <= 38 - RADIUS && Math.abs(p.z) <= 38 - RADIUS);
        }
    }
});

test('authority, live prediction, discarded-input replay and fractional previews share collision', () => {
    const room = new Room('PARITY'); room.botCount = 0;
    const a = room.add('Runner', 'runngun', 'blue'); room.start(0);
    Object.assign(a.state, moveState(-32.7, 0, 18), { vx: MAX_SPEED, grounded: false });
    let predicted = { ...a.state };
    for (let tick = 1; tick <= 180; tick++) {
        const i = { ...neutralInput(tick * 3), life: a.state.life, strafe: 1, slot: 3 as const, slide: tick % 5 < 2, jump: tick % 9 === 0 };
        const replay = reconcile(a.state, [i], true).predicted;
        predictInput(predicted, i, true);
        assert.ok(room.enqueue(a, [i], tick * STEP * 1000)); room.tick(tick * STEP * 1000);
        for (const key of ['x', 'y', 'z', 'vx', 'vy', 'vz'] as const) {
            assert.equal(predicted[key], a.state[key], `${key}, tick ${tick}`);
            assert.equal(replay[key], a.state[key]);
        }
        const preview = previewInput(predicted, i, true, .5)!;
        for (const b of SOLID_BOXES) assert.equal(inside(preview, b), false);
    }
});

test('underpass remains open and the deck stops upward and high-speed downward motion', () => {
    const p = moveState(-3, 0, -9);
    for (let tick = 0; tick < 80; tick++) move(p, { ...neutralInput(tick), strafe: 1 });
    assert.ok(p.x > 8); assert.equal(p.y, 0);
    const jump = { ...moveState(0, 1.6, -9), vy: 60, grounded: false };
    move(jump, neutralInput()); assert.ok(jump.y + HEIGHT <= 3.54 + 1e-9);
    const fall = { ...moveState(0, 10, -9), vy: -400, grounded: false };
    move(fall, neutralInput()); assert.equal(fall.y, 4); assert.equal(fall.grounded, true);
});
