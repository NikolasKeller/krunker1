import { SOLID_BOXES, RAMPS, MAP_SIZE, rampHeight, type MapBox } from '../src/shared/map';
import { GRAVITY, JUMP_SPEED, MAX_SPEED, RADIUS, HEIGHT, move, moveState, neutralInput } from '../src/shared/movement';
import { STEP } from '../src/shared/types';

export function edgeSession() {
    const boxes = [...SOLID_BOXES], ramps = [...RAMPS];
    const failures: unknown[] = [];
    let cases = 0, ticks = 0, velocityViolations = 0, displacementViolations = 0, penetrations = 0, maxUnexpectedRise = 0;
    const overlap = (p: ReturnType<typeof moveState>, b: MapBox) => Math.abs(p.x - b.x) < b.w / 2 + RADIUS - 1e-8 && Math.abs(p.z - b.z) < b.d / 2 + RADIUS - 1e-8 && p.y < b.y + b.h / 2 - 1e-8 && p.y + (p.slide > 0 ? 1.26 : HEIGHT) > b.y - b.h / 2 + 1e-8;
    function exercise(label: string, p: ReturnType<typeof moveState>, dx: number, dz: number, mode: string, count = 12) {
        cases++;
        const yaw = Math.atan2(-dx, -dz), norm = Math.hypot(dx, dz);
        for (let tick = 0; tick < count; tick++) {
            p.vx = dx / norm * MAX_SPEED; p.vz = dz / norm * MAX_SPEED;
            const i = { ...neutralInput(tick), yaw, slide: mode === 'slide', jump: mode === 'hop' && tick % 10 === 0 };
            const before = { ...p };
            const canJump = (i.jump && !p.jumpHeld || p.jumpBuffer > STEP) && (p.grounded || p.coyote > STEP);
            move(p, i); ticks++;
            const allowedVy = canJump ? JUMP_SPEED - GRAVITY * STEP : Math.max(0, before.vy - GRAVITY * STEP);
            const badVelocity = p.vy > allowedVy + 1e-8;
            // Ramp slope can lift .4 m per metre of uphill motion; box stairs
            // can lift .34 m, but a wall/corner may never eject horizontally.
            const allowedRise = Math.max(.34, Math.max(0, allowedVy) * STEP, Math.hypot(p.x - before.x, p.z - before.z) * .4);
            const excessRise = Math.max(0, p.y - before.y - allowedRise);
            maxUnexpectedRise = Math.max(maxUnexpectedRise, excessRise);
            const badDisplacement = Math.hypot(p.x - before.x, p.z - before.z) > MAX_SPEED * STEP + 1e-8 || excessRise > 1e-8;
            const badOverlap = SOLID_BOXES.some(b => overlap(p, b));
            if (badVelocity) velocityViolations++;
            if (badDisplacement) displacementViolations++;
            if (badOverlap) penetrations++;
            if ((badVelocity || badDisplacement || badOverlap) && failures.length < 20) failures.push({ label, tick, before, after: { ...p }, badVelocity, badDisplacement, badOverlap });
        }
    }
    let sideRise = 0, airborneRampRise = 0, stepHeight = 0, stepX = 0;
    try {
        // Each actual collider at its real coordinates; all four faces, both
        // corners of each face, tangent rounding offsets and three move modes.
        RAMPS.length = 0;
        for (const [index, b] of boxes.entries()) {
            SOLID_BOXES.splice(0, SOLID_BOXES.length, b);
            for (const axis of ['x', 'z'] as const) for (const sign of [-1, 1]) for (const edge of [-1, 0, 1])
                for (const epsilon of [1e-6, 1e-10]) for (const mode of ['run', 'slide', 'hop']) {
                    const other = axis === 'x' ? 'z' : 'x', half = (axis === 'x' ? b.w : b.d) / 2, across = (axis === 'x' ? b.d : b.w) / 2;
                    const p = moveState(b.x, Math.max(0, b.y - b.h / 2), b.z);
                    p[axis] += sign * (half + RADIUS + epsilon); p[other] += edge * (across + RADIUS - epsilon);
                    if (Math.abs(p.x) > MAP_SIZE / 2 - RADIUS || Math.abs(p.z) > MAP_SIZE / 2 - RADIUS) continue;
                    const da = -sign, db = -edge * .7;
                    exercise(`box ${index} ${axis}/${sign} edge ${edge} ${epsilon} ${mode}`, p, axis === 'x' ? da : db, axis === 'x' ? db : da, mode);
                }
        }
        SOLID_BOXES.splice(0, SOLID_BOXES.length, ...boxes); RAMPS.push(...ramps);
        for (const [index, b] of boxes.entries()) for (const axis of ['x', 'z'] as const) for (const sign of [-1, 1])
            for (const edge of [-1, 0, 1]) for (const mode of ['run', 'slide', 'hop']) {
                const other = axis === 'x' ? 'z' : 'x';
                const p = moveState(b.x, Math.max(0, b.y - b.h / 2), b.z);
                p[axis] += sign * ((axis === 'x' ? b.w : b.d) / 2 + RADIUS + .001);
                p[other] += edge * ((axis === 'x' ? b.d : b.w) / 2 + RADIUS - .001);
                if (Math.abs(p.x) > MAP_SIZE / 2 - RADIUS || Math.abs(p.z) > MAP_SIZE / 2 - RADIUS || boxes.some(b => overlap(p, b))) continue;
                if (ramps.some(r => (rampHeight(r, p.x, p.z) ?? 0) > p.y)) continue;
                if (p.y) { p.grounded = false; p.vy = mode === 'hop' ? JUMP_SPEED : 0; }
                exercise(`assembled box ${index} ${axis}/${sign} edge ${edge} ${mode}`, p, axis === 'x' ? -sign : -edge * .7, axis === 'z' ? -sign : -edge * .7, mode, 24);
            }
        // Assembled geometry: sweep all side edges, low/high ramp ends and their
        // platform junctions. Elevated starts are airborne, never fake support.
        for (const [index, r] of ramps.entries()) for (const axis of ['x', 'z'] as const) for (const sign of [-1, 1])
            for (let fraction = -1; fraction <= 1.001; fraction += .1) for (const mode of ['run', 'slide', 'hop']) for (const height of [0, .4, 2, 4]) {
                const other = axis === 'x' ? 'z' : 'x';
                const p = moveState(r.x, height, r.z);
                p[axis] += sign * ((axis === 'x' ? r.w : r.d) / 2 + RADIUS + .001);
                p[other] += fraction * ((axis === 'x' ? r.d : r.w) / 2 + RADIUS);
                if (SOLID_BOXES.some(b => overlap(p, b))) continue;
                if (height) { p.grounded = false; p.vy = mode === 'hop' ? JUMP_SPEED : 0; }
                exercise(`ramp ${index} ${axis}/${sign} ${fraction.toFixed(1)} y${height} ${mode}`, p, axis === 'x' ? -sign : 0, axis === 'z' ? -sign : 0, mode, 24);
            }
        const side = { ...moveState(-14, 0, -3.881), vz: MAX_SPEED };
        move(side, neutralInput()); sideRise = side.y;
        const air = { ...moveState(-14, .35, -3.881), vz: MAX_SPEED, vy: 1, grounded: false };
        move(air, neutralInput()); airborneRampRise = air.y - .35;
        RAMPS.length = 0; SOLID_BOXES.splice(0, SOLID_BOXES.length, { x: 0, y: .15, z: 0, w: 3, h: .3, d: 3, color: 0 });
        const step = { ...moveState(-1.881, 0, 0), vx: MAX_SPEED, slide: .6, slideHeld: true };
        move(step, { ...neutralInput(), slide: true }); stepHeight = step.y; stepX = step.x;
    } finally { SOLID_BOXES.splice(0, SOLID_BOXES.length, ...boxes); RAMPS.splice(0, RAMPS.length, ...ramps); }
    return { cases, ticks, velocityViolations, displacementViolations, penetrations, maxUnexpectedRise, sideRise, airborneRampRise, stepHeight, stepX, failures };
}
