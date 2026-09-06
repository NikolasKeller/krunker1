import { SOLID_BOXES, RAMPS } from './map';
import type { Vec3, PlayerState } from './types';
export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const angleLerp = (a: number, b: number, t: number) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;
export const distance = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
export function direction(yaw: number, pitch: number): Vec3 { return { x: -Math.sin(yaw) * Math.cos(pitch), y: Math.sin(pitch), z: -Math.cos(yaw) * Math.cos(pitch) }; }
export function rayBox(o: Vec3, d: Vec3, min: Vec3, max: Vec3): number | null {
    let near = 0, far = Infinity;
    for (const a of ['x', 'y', 'z'] as const) {
        if (Math.abs(d[a]) < 1e-9) {
            if (o[a] < min[a] || o[a] > max[a])
                return null;
        }
        else {
            let a0 = (min[a] - o[a]) / d[a], a1 = (max[a] - o[a]) / d[a];
            if (a0 > a1)
                [a0, a1] = [a1, a0];
            near = Math.max(near, a0);
            far = Math.min(far, a1);
            if (near > far)
                return null;
        }
    }
    return near;
}
// Clip a ray against the five planes of the solid wedge, including its sloped top.
export function rayRamp(o: Vec3, d: Vec3, r: typeof RAMPS[number]): number | null {
    const slope = r.sign * r.h / (r.axis === 'x' ? r.w : r.d);
    const n = r.axis === 'x' ? { x: -slope, y: 1, z: 0 } : { x: 0, y: 1, z: -slope };
    const planes: [
        Vec3,
        number
    ][] = [[{ x: 1, y: 0, z: 0 }, r.x + r.w / 2], [{ x: -1, y: 0, z: 0 }, -r.x + r.w / 2], [{ x: 0, y: 0, z: 1 }, r.z + r.d / 2], [{ x: 0, y: 0, z: -1 }, -r.z + r.d / 2], [{ x: 0, y: -1, z: 0 }, 0], [n, r.h / 2 - slope * (r.axis === 'x' ? r.x : r.z)]];
    let near = 0, far = Infinity;
    for (const [p, b] of planes) {
        const v = p.x * d.x + p.y * d.y + p.z * d.z, q = b - p.x * o.x - p.y * o.y - p.z * o.z;
        if (Math.abs(v) < 1e-9) {
            if (q < 0)
                return null;
        }
        else if (v < 0)
            near = Math.max(near, q / v);
        else
            far = Math.min(far, q / v);
        if (near > far)
            return null;
    }
    return near;
}
export function worldHit(o: Vec3, d: Vec3, range = 150): number {
    let best = range;
    for (const b of SOLID_BOXES) {
        const t = rayBox(o, d, { x: b.x - b.w / 2, y: b.y - b.h / 2, z: b.z - b.d / 2 }, { x: b.x + b.w / 2, y: b.y + b.h / 2, z: b.z + b.d / 2 });
        if (t !== null && t < best)
            best = t;
    }
    for (const r of RAMPS) {
        const t = rayRamp(o, d, r);
        if (t !== null && t < best)
            best = t;
    }
    if (d.y < 0)
        best = Math.min(best, -o.y / d.y);
    return best;
}
export function hitPlayer(o: Vec3, d: Vec3, p: Pick<PlayerState, 'x' | 'y' | 'z' | 'slide'>) {
    const crouch = p.slide > 0 ? 0.68 : 1;
    const zones = [{ zone: 'head' as const, lo: 1.35, hi: 1.88, r: 0.29 }, { zone: 'body' as const, lo: 0.65, hi: 1.35, r: 0.4 }, { zone: 'legs' as const, lo: 0, hi: 0.65, r: 0.32 }];
    let best: {
        zone: 'head' | 'body' | 'legs';
        distance: number;
    } | null = null;
    for (const z of zones) {
        const t = rayBox(o, d, { x: p.x - z.r, y: p.y + z.lo * crouch, z: p.z - z.r }, { x: p.x + z.r, y: p.y + z.hi * crouch, z: p.z + z.r });
        if (t !== null && (!best || t < best.distance))
            best = { zone: z.zone, distance: t };
    }
    return best;
}
export function random(seed: number): () => number { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
