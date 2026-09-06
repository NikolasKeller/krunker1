import { SOLID_BOXES, RAMPS, MAP_SIZE } from './map';
import { HEIGHT, RADIUS } from './movement';
import type { Vec3 } from './types';

type Plane = [number, number, number, number];
// A point moving through convex planes expanded by the player's body. Tangent
// motion on a contact plane is allowed; entry through either face is blocked.
function entry(from: Vec3, delta: Vec3, planes: Plane[]) {
    let near = -Infinity, far = Infinity;
    for (const [x, y, z, limit] of planes) {
        const gap = limit - x * from.x - y * from.y - z * from.z;
        const speed = x * delta.x + y * delta.y + z * delta.z;
        if (Math.abs(speed) < 1e-10) {
            if (gap <= 1e-9) return 1;
        } else if (speed < 0) near = Math.max(near, gap / speed);
        else far = Math.min(far, gap / speed);
        if (near >= far) return 1;
    }
    return far <= 1e-9 ? 1 : Math.max(0, Math.min(1, near));
}
// Render previews, reconciliation offsets and remote extrapolation must never
// draw a body/camera through a solid even when both endpoints are legal.
export function clipPlayerMotion(from: Vec3, to: Vec3, height = HEIGHT, radius = RADIUS): Vec3 {
    const d = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z };
    if (!d.x && !d.y && !d.z) return { ...to };
    let t = 1;
    for (const b of SOLID_BOXES) {
        t = Math.min(t, entry(from, d, [
            [1, 0, 0, b.x + b.w / 2 + radius], [-1, 0, 0, -b.x + b.w / 2 + radius],
            [0, 0, 1, b.z + b.d / 2 + radius], [0, 0, -1, -b.z + b.d / 2 + radius],
            [0, 1, 0, b.y + b.h / 2], [0, -1, 0, -b.y + b.h / 2 + height],
        ]));
    }
    for (const r of RAMPS) {
        const slope = r.sign * r.h / (r.axis === 'x' ? r.w : r.d);
        t = Math.min(t, entry(from, d, [
            [1, 0, 0, r.x + r.w / 2 + radius], [-1, 0, 0, -r.x + r.w / 2 + radius],
            [0, 0, 1, r.z + r.d / 2 + radius], [0, 0, -1, -r.z + r.d / 2 + radius],
            [0, -1, 0, height], [0, 1, 0, r.h],
            [r.axis === 'x' ? -slope : 0, 1, r.axis === 'z' ? -slope : 0,
                r.h / 2 - slope * r[r.axis] + Math.abs(slope) * radius],
        ]));
    }
    for (const axis of ['x', 'z'] as const) if (d[axis]) {
        const edge = Math.sign(d[axis]) * (MAP_SIZE / 2 - radius);
        t = Math.min(t, Math.max(0, (edge - from[axis]) / d[axis]));
    }
    if (d.y < 0) t = Math.min(t, Math.max(0, -from.y / d.y));
    return { x: from.x + d.x * t, y: from.y + d.y * t, z: from.z + d.z * t };
}
