import { clamp, worldHit } from '../shared/math';
import { visibleTargets } from '../shared/combat';
import { eyeHeight } from '../shared/movement';
import type { Mode, PlayerState } from '../shared/types';
const wrap = (v: number) => Math.atan2(Math.sin(v), Math.cos(v));
// Only during an intentional touch drag. No idle tracking, head targeting,
// hitbox changes, or assistance through cover. At most 0.1 degree per 60 Hz frame.
export function assistedLook(yaw: number, pitch: number, dx: number, dy: number, dt: number, p: PlayerState | undefined, players: PlayerState[], mode: Mode, now: number) {
    if (!p?.alive || !Math.hypot(dx, dy)) return { yaw: yaw + dx, pitch: clamp(pitch + dy, -1.54, 1.54) };
    const origin = { x: p.x, y: p.y + eyeHeight(p), z: p.z };
    let target: { yaw: number; pitch: number; angle: number } | undefined;
    for (const q of visibleTargets(p, players, mode, now)) {
        const x = q.x - origin.x, y = q.y + (q.slide > 0 ? .72 : 1.1) - origin.y, z = q.z - origin.z;
        const range = Math.hypot(x, y, z); if (range < 1 || range > 65) continue;
        const ty = wrap(Math.atan2(-x, -z) - yaw), tp = Math.atan2(y, Math.hypot(x, z)) - pitch;
        const angle = Math.hypot(ty * Math.cos(pitch), tp);
        if (angle > .07 || (target && angle >= target.angle)) continue;
        if (worldHit(origin, { x: x / range, y: y / range, z: z / range }, range) < range - .05) continue;
        target = { yaw: ty, pitch: tp, angle };
    }
    if (!target) return { yaw: yaw + dx, pitch: clamp(pitch + dy, -1.54, 1.54) };
    const proximity = 1 - target.angle / .07;
    const slowdown = 1 - .18 * proximity;
    const budget = Math.min(.105 * Math.min(dt, .033), Math.hypot(dx, dy) * .12) * proximity;
    const length = Math.hypot(target.yaw, target.pitch) || 1;
    return { yaw: yaw + dx * slowdown + target.yaw / length * budget, pitch: clamp(pitch + dy * slowdown + target.pitch / length * budget, -1.54, 1.54) };
}
