import type { Input, MoveState } from './types';
import { STEP, MAX_INTERPOLATION_DELAY_MS } from './types';
import { SOLID_BOXES as BOXES, RAMPS, MAP_SIZE, rampHeight } from './map';
import { clamp } from './math';
export const RADIUS = 0.38, HEIGHT = 1.88, EYE = 1.62;
export const BASE_SPEED = 10.8, MAX_SPEED = 28, GRAVITY = 24, JUMP_SPEED = 8.6;
export function moveState(x = 0, y = 0, z = 0): MoveState { return { x, y, z, vx: 0, vy: 0, vz: 0, grounded: true, slide: 0, slideHeld: false, jumpHeld: false, groundTime: 1, jumpBuffer: 0, coyote: 0, slideAge: 1 }; }
export function neutralInput(seq = 0): Input { return { seq, forward: 0, strafe: 0, yaw: 0, pitch: 0, jump: false, slide: false, fire: false, aim: false, reload: false, slot: 1, shotTime: 0 }; }
export function validInput(v: unknown): v is Input {
    if (!v || typeof v !== 'object')
        return false;
    const i = v as Input;
    if (i.interpolationDelay !== undefined && (!Number.isFinite(i.interpolationDelay) || i.interpolationDelay < 0 || i.interpolationDelay > MAX_INTERPOLATION_DELAY_MS)) return false;
    if (i.combat !== undefined && typeof i.combat !== 'boolean') return false;
    return (i.life === undefined || (Number.isSafeInteger(i.life) && i.life >= 0)) && Number.isSafeInteger(i.seq) && i.seq >= 0 && i.seq < 2 ** 31 && Number.isFinite(i.forward) && Math.abs(i.forward) <= 1 && Number.isFinite(i.strafe) && Math.abs(i.strafe) <= 1 && Number.isFinite(i.yaw) && Math.abs(i.yaw) < 1e7 && Number.isFinite(i.pitch) && Math.abs(i.pitch) <= Math.PI / 2 && Number.isFinite(i.shotTime) && ['jump', 'slide', 'fire', 'aim', 'reload'].every(k => typeof (i as unknown as Record<string, unknown>)[k] === 'boolean') && [1, 2, 3].includes(i.slot);
}
export function eyeHeight(p: Pick<MoveState, 'slide'>) { return p.slide > 0 ? 1.08 : EYE; }
export function move(p: MoveState, i: Input, speedScale = 1, dt = STEP): void {
    p.slideAge += dt;
    if (i.jump && !p.jumpHeld)
        p.jumpBuffer = 0.12;
    else
        p.jumpBuffer = Math.max(0, p.jumpBuffer - dt);
    if (i.slide && !p.slideHeld)
        p.slideAge = 0;
    p.jumpHeld = i.jump;
    p.slideHeld = i.slide;
    if (p.grounded) {
        p.coyote = 0.07;
        p.groundTime += dt;
    }
    else {
        p.coyote = Math.max(0, p.coyote - dt);
        p.groundTime = 0;
    }
    let speed = Math.hypot(p.vx, p.vz);
    if (p.grounded && i.slide && p.slide <= 0 && p.slideAge < 0.25 && speed > 5) {
        p.slide = 0.65;
        const boost = p.slideAge < 0.13 ? 1.16 : 1.09;
        p.vx *= boost;
        p.vz *= boost;
    }
    if (p.jumpBuffer > 0 && (p.grounded || p.coyote > 0)) {
        const timed = p.groundTime < 0.13 && speed > 5;
        if (timed) {
            p.vx *= p.slide > 0 ? 1.105 : 1.035;
            p.vz *= p.slide > 0 ? 1.105 : 1.035;
        }
        p.vy = JUMP_SPEED * (i.aim ? 0.94 : 1);
        p.grounded = false;
        p.coyote = 0;
        p.jumpBuffer = 0;
        p.slide = 0;
    }
    p.slide = Math.max(0, p.slide - dt);
    if (!i.slide)
        p.slide = 0;
    const len = Math.hypot(i.forward, i.strafe), f = len > 0 ? i.forward / len : 0, s = len > 0 ? i.strafe / len : 0;
    const wx = -Math.sin(i.yaw) * f + Math.cos(i.yaw) * s, wz = -Math.cos(i.yaw) * f - Math.sin(i.yaw) * s;
    const wish = Math.min(1, len) * BASE_SPEED * speedScale * (len > 1.001 ? 1.12 : 1) * (i.aim ? 0.83 : 1);
    if (p.grounded && p.slide <= 0) {
        const friction = Math.max(0, 1 - 8.5 * dt);
        p.vx *= friction;
        p.vz *= friction;
    }
    if (p.slide > 0 && len > 0) {
        speed = Math.hypot(p.vx, p.vz);
        const steer = Math.min(1, 7.5 * dt);
        p.vx = p.vx * (1 - steer) + wx * speed * steer;
        p.vz = p.vz * (1 - steer) + wz * speed * steer;
        const after = Math.hypot(p.vx, p.vz);
        if (after > 0) {
            p.vx *= speed / after;
            p.vz *= speed / after;
        }
        p.vx *= 1 - 0.5 * dt;
        p.vz *= 1 - 0.5 * dt;
    }
    else if (len > 0) {
        const current = p.vx * wx + p.vz * wz, add = Math.max(0, wish - current), accel = (p.grounded ? 110 : 18) * dt;
        const a = Math.min(add, accel);
        p.vx += wx * a;
        p.vz += wz * a;
    }
    speed = Math.hypot(p.vx, p.vz);
    if (speed > MAX_SPEED) {
        p.vx *= MAX_SPEED / speed;
        p.vz *= MAX_SPEED / speed;
    }
    p.vy -= GRAVITY * dt;
    // Bound displacement in all three axes, independently of tick duration and
    // slide/hop boosts. Forces and input edges still run exactly once per tick.
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(p.vx), Math.abs(p.vy), Math.abs(p.vz)) * dt / 0.1));
    for (let step = 0; step < steps; step++) resolveMovement(p, dt / steps);
}
function rampFloor(r: typeof RAMPS[number], x: number, z: number) {
    if (Math.abs(x - r.x) >= r.w / 2 + RADIUS || Math.abs(z - r.z) >= r.d / 2 + RADIUS) return null;
    return rampHeight(r, clamp(x + (r.axis === 'x' ? r.sign * RADIUS : 0), r.x - r.w / 2, r.x + r.w / 2),
        clamp(z + (r.axis === 'z' ? r.sign * RADIUS : 0), r.z - r.d / 2, r.z + r.d / 2));
}
function resolveMovement(p: MoveState, dt: number) {
    const oldY = p.y, bodyH = p.slide > 0 ? 1.26 : HEIGHT;
    for (const axis of ['x', 'z'] as const) {
        const velocity = axis === 'x' ? 'vx' : 'vz';
        const start = p[axis];
        p[axis] += p[velocity] * dt;
        for (const b of BOXES) {
            if (p.y >= b.y + b.h / 2 - 1e-9 || p.y + bodyH <= b.y - b.h / 2 + 1e-9)
                continue;
            // A resolved contact is not penetration on the other axis. At real
            // map coordinates (-26.38 against x=-19), subtraction can round a
            // tangent distance below half + RADIUS and eject Z an entire house
            // width. Use the same contact tolerance as the vertical faces.
            if (Math.abs(p.x - b.x) < b.w / 2 + RADIUS - 1e-9 && Math.abs(p.z - b.z) < b.d / 2 + RADIUS - 1e-9) {
                const top = b.y + b.h / 2;
                if (top - p.y <= 0.34 && p.grounded && !BOXES.some(ceiling =>
                    Math.abs(p.x - ceiling.x) < ceiling.w / 2 + RADIUS && Math.abs(p.z - ceiling.z) < ceiling.d / 2 + RADIUS &&
                    ceiling.y - ceiling.h / 2 >= p.y + bodyH - 1e-9 && ceiling.y - ceiling.h / 2 < top + bodyH)) {
                    p.y = top;
                    continue;
                }
                const center = axis === 'x' ? b.x : b.z, half = axis === 'x' ? b.w / 2 : b.d / 2;
                p[axis] = center + (start < center ? -1 : 1) * (half + RADIUS);
                p[velocity] = 0;
            }
        }
        for (const r of RAMPS) {
            const h = rampFloor(r, p.x, p.z);
            if (h !== null && h > p.y + 0.62 && p.y < r.h) {
                p[axis] = start;
                p[velocity] = 0;
            }
        }
    }
    p.y += p.vy * dt;
    p.grounded = false;
    let floor = 0;
    for (const b of BOXES) {
        if (Math.abs(p.x - b.x) < b.w / 2 + RADIUS && Math.abs(p.z - b.z) < b.d / 2 + RADIUS) {
            const top = b.y + b.h / 2;
            if (oldY >= top - 1e-9 && p.y <= top && p.vy <= 0)
                floor = Math.max(floor, top);
            const bottom = b.y - b.h / 2;
            if (p.vy > 0 && oldY + bodyH <= bottom && p.y + bodyH >= bottom) {
                p.y = bottom - bodyH;
                p.vy = 0;
            }
        }
    }
    for (const r of RAMPS) {
        const h = rampFloor(r, p.x, p.z);
        if (h !== null && h <= oldY + 0.65)
            floor = Math.max(floor, h);
    }
    if (p.y <= floor) {
        p.y = floor;
        p.vy = 0;
        p.grounded = true;
    }
    p.x = clamp(p.x, -MAP_SIZE / 2 + RADIUS, MAP_SIZE / 2 - RADIUS);
    p.z = clamp(p.z, -MAP_SIZE / 2 + RADIUS, MAP_SIZE / 2 - RADIUS);
}
