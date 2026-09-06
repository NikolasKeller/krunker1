import { clipPlayerMotion } from './collision';
import { GRENADE } from './abilities';
import { getClientMap } from './map';
import type { Vec3 } from './types';

export interface GrenadeBody { position: Vec3; velocity: Vec3 }
// A small swept body uses the same solid boxes, ramps and world boundaries as
// player motion. Per-axis contacts bounce; 2 cm substeps prevent thin-wall skips.
export function stepGrenade(g: GrenadeBody, dt: number, map = getClientMap()) {
    const steps = Math.max(1, Math.ceil((Math.hypot(g.velocity.x, g.velocity.y, g.velocity.z) + GRENADE.gravity * dt) * dt / .02));
    const step = dt / steps;
    for (let n = 0; n < steps; n++) {
        g.velocity.y -= GRENADE.gravity * step;
        for (const axis of ['x', 'z', 'y'] as const) {
            const from = { ...g.position, y: g.position.y - GRENADE.size };
            const target = { ...from, [axis]: from[axis] + g.velocity[axis] * step };
            const clipped = clipPlayerMotion(from, target, GRENADE.size * 2, GRENADE.size, map);
            g.position[axis] = clipped[axis] + (axis === 'y' ? GRENADE.size : 0);
            if (Math.abs(clipped[axis] - target[axis]) > 1e-9) {
                g.velocity[axis] *= -.42;
                if (axis === 'y') { g.velocity.x *= .72; g.velocity.z *= .72; }
                if (Math.abs(g.velocity[axis]) < .3) g.velocity[axis] = 0;
            }
        }
    }
}
