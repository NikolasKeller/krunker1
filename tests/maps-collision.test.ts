import assert from 'node:assert/strict';
import test from 'node:test';
import { MAPS, type MapBox, type MapDefinition, type Ramp } from '../src/shared/map';
import { move, moveState, neutralInput, MAX_SPEED, HEIGHT, RADIUS } from '../src/shared/movement';
import { clipPlayerMotion } from '../src/shared/collision';
import { worldHit } from '../src/shared/math';
import { STEP, type MoveState } from '../src/shared/types';

const angles = [-Math.PI / 3, -.35, 0, .35, Math.PI / 3];
function inside(p: MoveState, b: MapBox) {
    return Math.abs(p.x - b.x) < b.w / 2 + RADIUS - 1e-8 && Math.abs(p.z - b.z) < b.d / 2 + RADIUS - 1e-8 &&
        p.y < b.y + b.h / 2 - 1e-8 && p.y + (p.slide > 0 ? 1.26 : HEIGHT) > b.y - b.h / 2 + 1e-8;
}
function rampTop(p: MoveState, r: Ramp) {
    if (Math.abs(p.x - r.x) >= r.w / 2 + RADIUS - 1e-8 || Math.abs(p.z - r.z) >= r.d / 2 + RADIUS - 1e-8) return 0;
    const span = r.axis === 'x' ? r.w : r.d;
    return Math.max(0, Math.min(r.h, (.5 + (p[r.axis] - r[r.axis] + r.sign * RADIUS) / span * r.sign) * r.h));
}
function legal(p: MoveState, map: MapDefinition) {
    return !map.boxes.some(b => inside(p, b)) && !map.ramps.some(r => rampTop(p, r) > p.y + 1e-8);
}

for (const map of MAPS) {
    test(`${map.name}: every solid face blocks maximum-speed air/slide/hop movement and hitscan at five angles`, () => {
        let checks = 0;
        for (const original of map.boxes) for (const axis of ['x', 'z'] as const) for (const sign of [-1, 1])
            for (const angle of angles) for (const mode of ['air', 'slide', 'hop']) for (const dt of [STEP, .05]) {
                const b = { ...original, x: 0, z: 0 }, other = axis === 'x' ? 'z' : 'x';
                b[axis] = sign * (axis === 'x' ? b.w : b.d) / 2;
                const fixture = { ...map, size: 400, boxes: [b], ramps: [] };
                const p = moveState(0, Math.max(0, b.y - b.h / 2 - .5), 0);
                p[axis] = -sign * (RADIUS + .001); p.grounded = mode !== 'air'; p.groundTime = 0;
                p[axis === 'x' ? 'vx' : 'vz'] = sign * MAX_SPEED * Math.cos(angle);
                p[other === 'x' ? 'vx' : 'vz'] = MAX_SPEED * Math.sin(angle);
                const from = { ...p };
                const input = { ...neutralInput(), slide: mode !== 'air', jump: mode === 'hop' };
                move(p, input, 1.12 * 1.16, dt, fixture);
                const label = JSON.stringify({ map: map.id, original, axis, sign, angle, mode, dt });
                assert.ok(!inside(p, b) && p[axis] * sign <= -RADIUS + 1e-8, label);
                const to = { ...from, [axis]: from[axis] + sign * MAX_SPEED * dt };
                const clipped = clipPlayerMotion(from, to, HEIGHT, RADIUS, fixture);
                assert.ok(clipped[axis] * sign <= -RADIUS + 1e-8, `camera: ${label}`);
                const origin = { x: 0, y: b.y, z: 0, [axis]: -sign };
                assert.ok(worldHit(origin, { x: 0, y: 0, z: 0, [axis]: sign }, 3, fixture) <= 1.000001, `bullet: ${label}`);
                checks++;
            }
        console.log(`${map.name}: ${checks} solid-face collision / camera / hitscan checks at ${MAX_SPEED} m/s`);
    });

    test(`${map.name}: every solid top and underside catches fast vertical motion`, () => {
        for (const original of map.boxes) {
            const b = { ...original, x: 0, y: 10 + original.h / 2, z: 0 };
            const fixture = { ...map, size: 400, boxes: [b], ramps: [] };
            for (const fraction of [-.45, 0, .45]) {
                const up = { ...moveState(b.w * fraction, 10 - HEIGHT - .001, b.d * fraction), grounded: false, vy: 400 };
                move(up, neutralInput(), 1, .05, fixture);
                assert.ok(up.y + HEIGHT <= 10 + 1e-8 && !inside(up, b), `underside: ${JSON.stringify(original)}`);
                const down = { ...moveState(b.w * fraction, 10 + b.h + .001, b.d * fraction), grounded: false, vy: -400 };
                move(down, neutralInput(), 1, .05, fixture);
                assert.ok(Math.abs(down.y - (10 + b.h)) < 1e-8); assert.ok(down.grounded);
            }
        }
    });

    test(`${map.name}: every ramp climbs cleanly, blocks side entry and catches high-speed falls`, () => {
        for (const original of map.ramps) {
            const r = { ...original, x: 0, z: 0 }, fixture = { ...map, boxes: [], ramps: [r] };
            const span = r.axis === 'x' ? r.w : r.d, cross = r.axis === 'x' ? 'z' : 'x';
            const velocity = r.axis === 'x' ? 'vx' : 'vz';
            for (const speed of [10.8, MAX_SPEED]) {
                const p = moveState(); p[r.axis] = -r.sign * (span / 2 + RADIUS + .2);
                let peak = 0;
                for (let tick = 0; tick < 240; tick++) {
                    p[velocity] = r.sign * speed; p.slide = .5; p.slideHeld = true;
                    move(p, { ...neutralInput(), slide: true }, 1, STEP, fixture);
                    assert.ok(legal(p, fixture), `ramp penetration: ${JSON.stringify({ map: map.id, r, p })}`);
                    peak = Math.max(peak, p.y);
                }
                assert.ok(peak >= r.h - 1e-6, `cannot climb ${map.id} ${JSON.stringify(r)} at ${speed}`);
                assert.ok(p[r.axis] * r.sign > span / 2 + RADIUS, 'traverses the full incline');
            }
            for (const sign of [-1, 1]) for (const angle of angles) for (const fraction of [-.25, 0, .25]) {
                const p = moveState(); p[r.axis] = span * fraction;
                p[cross] = sign * ((cross === 'x' ? r.w : r.d) / 2 + RADIUS + .001);
                p[cross === 'x' ? 'vx' : 'vz'] = -sign * MAX_SPEED * Math.cos(angle);
                p[velocity] = MAX_SPEED * Math.sin(angle); p.grounded = false;
                move(p, neutralInput(), 1, .05, fixture);
                assert.ok(legal(p, fixture), `side entry ${map.id}: ${JSON.stringify({ r, p })}`);
            }
            for (const angle of angles) {
                const p = moveState(); p[r.axis] = r.sign * (span / 2 + RADIUS + .001);
                p[velocity] = -r.sign * MAX_SPEED * Math.cos(angle);
                p[cross === 'x' ? 'vx' : 'vz'] = MAX_SPEED * Math.sin(angle); p.grounded = false;
                move(p, neutralInput(), 1, .05, fixture);
                assert.ok(legal(p, fixture), `ramp end face: ${map.id} ${JSON.stringify(r)}`);
            }
            const fall = { ...moveState(0, 16, 0), vy: -400, grounded: false };
            move(fall, neutralInput(), 1, .05, fixture);
            assert.ok(legal(fall, fixture) && fall.grounded);
            assert.ok(Math.abs(fall.y - rampTop(fall, r)) < 1e-8);
        }
    });

    test(`${map.name}: assembled walls, ramp joints, window seams and boundaries stay solid under repeated maximum-speed approaches`, () => {
        let probes = 0;
        for (const b of map.boxes) for (const axis of ['x', 'z'] as const) for (const side of [-1, 1]) for (const fraction of [-.45, 0, .45]) {
            const other = axis === 'x' ? 'z' : 'x';
            const start = moveState(b.x, Math.max(0, b.y - b.h / 2 - .5), b.z);
            start[axis] += side * ((axis === 'x' ? b.w : b.d) / 2 + RADIUS + .01);
            start[other] += fraction * (other === 'x' ? b.w : b.d);
            if (Math.max(Math.abs(start.x), Math.abs(start.z)) > map.size / 2 - RADIUS || !legal(start, map)) continue;
            for (const angle of angles) for (const mode of ['air', 'slide', 'hop']) {
                const p = { ...start, grounded: mode !== 'air' };
                for (let tick = 0; tick < 8; tick++) {
                    p[axis === 'x' ? 'vx' : 'vz'] = -side * MAX_SPEED * Math.cos(angle);
                    p[other === 'x' ? 'vx' : 'vz'] = MAX_SPEED * Math.sin(angle);
                    const before = { ...p };
                    move(p, { ...neutralInput(), slide: mode !== 'air', jump: mode === 'hop' && tick % 4 === 0 }, 1, STEP, map);
                    const label = JSON.stringify({ map: map.id, b, axis, side, fraction, angle, mode, tick, p });
                    assert.ok(legal(p, map), label);
                    assert.ok(Math.hypot(p.x - before.x, p.z - before.z) <= MAX_SPEED * STEP + 1e-7, `sideways ejection: ${label}`);
                    assert.ok(Math.max(Math.abs(p.x), Math.abs(p.z)) <= map.size / 2 - RADIUS + 1e-8, `boundary: ${label}`);
                    probes++;
                }
            }
        }
        assert.ok(probes > 1000);
        console.log(`${map.name}: ${probes} assembled-map movement steps`);
    });
}
