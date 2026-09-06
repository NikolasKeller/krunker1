import type { Vec3 } from './types';
export interface MapBox {
    x: number;
    y: number;
    z: number;
    w: number;
    h: number;
    d: number;
    color: number;
    kind?: 'building' | 'crate' | 'wall' | 'cover' | 'platform';
}
export interface Ramp {
    x: number;
    z: number;
    w: number;
    d: number;
    h: number;
    axis: 'x' | 'z';
    sign: number;
    color: number;
}
export const MAP_SIZE = 76;
export const MAP_NAME = 'SANDYARD';
const sand = 0x85827f, light = 0x969795, white = 0x687580;
export const BOXES: MapBox[] = [
    { x: 0, y: 3, z: -38, w: 78, h: 6, d: 2, color: sand, kind: 'wall' },
    { x: 0, y: 3, z: 38, w: 78, h: 6, d: 2, color: sand, kind: 'wall' },
    { x: -38, y: 3, z: 0, w: 2, h: 6, d: 76, color: sand, kind: 'wall' },
    { x: 38, y: 3, z: 0, w: 2, h: 6, d: 76, color: sand, kind: 'wall' },
    { x: -19, y: 3.5, z: -13, w: 14, h: 7, d: 14, color: light, kind: 'building' },
    { x: 19, y: 3.5, z: 13, w: 14, h: 7, d: 14, color: white, kind: 'building' },
    { x: 20, y: 3, z: -21, w: 12, h: 6, d: 10, color: 0x9b8173, kind: 'building' },
    { x: -20, y: 3, z: 21, w: 12, h: 6, d: 10, color: 0xb0aaa1, kind: 'building' },
    { x: 0, y: 2, z: 0, w: 10, h: 4, d: 10, color: 0x8a8982, kind: 'platform' },
    { x: 0, y: 3.77, z: -9, w: 10, h: 0.46, d: 8, color: 0x8a8982, kind: 'platform' },
    { x: -4.6, y: 1.77, z: -11.8, w: 0.8, h: 3.54, d: 0.8, color: light, kind: 'wall' },
    { x: 4.6, y: 1.77, z: -11.8, w: 0.8, h: 3.54, d: 0.8, color: light, kind: 'wall' },
    { x: -4.6, y: 1.77, z: -6, w: 0.8, h: 3.54, d: 0.8, color: light, kind: 'wall' },
    { x: 4.6, y: 1.77, z: -6, w: 0.8, h: 3.54, d: 0.8, color: light, kind: 'wall' },
    { x: 0, y: 4.45, z: -12.7, w: 10, h: 0.9, d: 0.6, color: light, kind: 'cover' },
    { x: -0.5, y: 5.6, z: 0, w: 3, h: 3.2, d: 3, color: white, kind: 'building' },
    { x: 7.3, y: 1.2, z: 20, w: 4.6, h: 2.4, d: 4.6, color: 0xb9884c, kind: 'crate' },
    { x: 10.3, y: 0.6, z: 23, w: 2.2, h: 1.2, d: 2.2, color: 0xc4975e, kind: 'crate' },
    { x: -7.6, y: 1.2, z: -23, w: 4.6, h: 2.4, d: 4.6, color: 0xb9884c, kind: 'crate' },
    { x: -10.7, y: 0.6, z: -25, w: 2.2, h: 1.2, d: 2.2, color: 0xc4975e, kind: 'crate' },
    { x: 27.5, y: 1.25, z: -4, w: 8, h: 2.5, d: 2.8, color: 0x548e91, kind: 'cover' },
    { x: -27.5, y: 1.25, z: 5, w: 8, h: 2.5, d: 2.8, color: 0xb3654c, kind: 'cover' },
    { x: 0, y: 0.85, z: 30, w: 7, h: 1.7, d: 2, color: light, kind: 'cover' },
    { x: 0, y: 0.85, z: -31, w: 7, h: 1.7, d: 2, color: light, kind: 'cover' },
    { x: 31, y: 1.15, z: 27, w: 3, h: 2.3, d: 3, color: 0xaf8049, kind: 'crate' },
    { x: -31, y: 1.15, z: -28, w: 3, h: 2.3, d: 3, color: 0xaf8049, kind: 'crate' },
];
// Solid architectural props use the same dimensions for rendering, movement and hitscan.
export const LAMP_POSITIONS = [[-32, 18], [32, -18], [-28, -34], [28, 34]];
export const DETAIL_BOXES: MapBox[] = [
    ...BOXES.filter(b => b.kind === 'building').map(b => ({ x: b.x, y: b.y + b.h / 2 + .12, z: b.z, w: b.w + .35, h: .24, d: b.d + .35, color: 0xb4b1a9 })),
    ...BOXES.filter(b => b.kind === 'building' && b.w > 5).flatMap(b => [
        { x: b.x + 3, y: b.h + .4, z: b.z - 2, w: 2.2, h: .8, d: 1.8, color: 0x656563 },
        { x: b.x + 3, y: b.h + .85, z: b.z - 2, w: 2.4, h: .12, d: 2, color: 0x969795 },
    ]),
    ...LAMP_POSITIONS.flatMap(([x, z]) => [
        { x, y: 2.5, z, w: .15, h: 5, d: .15, color: 0x65726e },
        { x: x + .5, y: 4.95, z, w: 1.1, h: .15, d: .15, color: 0x65726e },
        { x: x + 1, y: 4.83, z, w: .5, h: .13, d: .3, color: 0xe9e2c3 },
    ]),
];
export const SOLID_BOXES = [...BOXES, ...DETAIL_BOXES];
export const RAMPS: Ramp[] = [
    { x: -10, z: 0, w: 10, d: 7, h: 4, axis: 'x', sign: 1, color: 0x9d9587 },
    { x: 10, z: 0, w: 10, d: 7, h: 4, axis: 'x', sign: -1, color: 0x9d9587 },
    { x: 0, z: 10, w: 8, d: 10, h: 4, axis: 'z', sign: -1, color: 0x9d9587 },
];
export const SPAWNS: (Vec3 & {
    yaw: number;
})[] = [
    { x: -29, y: 0, z: 29, yaw: -2.35 }, { x: 29, y: 0, z: -29, yaw: 0.78 },
    { x: 29, y: 0, z: 32, yaw: 2.5 }, { x: -29, y: 0, z: -32, yaw: -0.6 },
    { x: -7, y: 0, z: 32, yaw: 0 }, { x: 8, y: 0, z: -32, yaw: Math.PI },
    { x: -32, y: 0, z: -1, yaw: -Math.PI / 2 }, { x: 32, y: 0, z: 5, yaw: Math.PI / 2 },
    { x: -35, y: 0, z: 14, yaw: -Math.PI / 2 }, { x: 35, y: 0, z: -14, yaw: Math.PI / 2 },
    { x: -18, y: 0, z: 34, yaw: 0 }, { x: 18, y: 0, z: -34, yaw: Math.PI },
    { x: -35, y: 0, z: -18, yaw: -Math.PI / 2 }, { x: 35, y: 0, z: 18, yaw: Math.PI / 2 },
    { x: 10, y: 0, z: 34, yaw: 0 }, { x: -12, y: 0, z: -34, yaw: Math.PI },
    { x: -35, y: 0, z: 24, yaw: -Math.PI / 2 }, { x: 35, y: 0, z: -24, yaw: Math.PI / 2 },
    { x: 20, y: 0, z: 34, yaw: 0 }, { x: -22, y: 0, z: -34, yaw: Math.PI },
];
export function rampHeight(r: Ramp, x: number, z: number): number | null {
    if (Math.abs(x - r.x) > r.w / 2 || Math.abs(z - r.z) > r.d / 2)
        return null;
    return Math.max(0, Math.min(r.h, (0.5 + (r.axis === 'x' ? (x - r.x) / r.w : (z - r.z) / r.d) * r.sign) * r.h));
}
