import type { Object3D } from 'three';
import type { GameEvent, Input, PlayerState, Vec3, WeaponId } from '../shared/types';
import { shotRays, recoilFor, WEAPONS } from '../shared/weapons';
import { eyeHeight } from '../shared/movement';
import { worldHit } from '../shared/math';
import type { Effects } from './effects';

export class ShotFeedback {
    private pending: { seq: number; weapon: WeaponId; impacts: Object3D[] }[] = [];
    constructor(private effects: Effects, private viewmodel: { fire(): void }, private audio: { shot(w: WeaponId): void }) {}
    clear() { this.pending = []; }
    fire(p: PlayerState, input: Input, index: number, aimProgress: number, muzzle: Vec3) {
        if (!input.fire) return;
        const w = WEAPONS[p.weapon], origin = { x: p.x, y: p.y + eyeHeight(p), z: p.z };
        const dirs = shotRays(p.weapon, input.yaw, input.pitch, Math.hypot(p.vx, p.vz), p.bloom, aimProgress, index, input.seq, p.life);
        const impacts: Object3D[] = [];
        if (p.weapon !== 'knife') {
            // The eye determines the aim ray; the tracer starts at the rendered
            // muzzle. A close wall can occlude the muzzle too.
            const dx = muzzle.x - origin.x, dy = muzzle.y - origin.y, dz = muzzle.z - origin.z, length = Math.hypot(dx, dy, dz);
            const reach = length ? worldHit(origin, { x: dx / length, y: dy / length, z: dz / length }, length) / length : 1;
            const from = { x: origin.x + dx * reach, y: origin.y + dy * reach, z: origin.z + dz * reach };
            for (const d of dirs) {
                const distance = worldHit(origin, d, w.range);
                const end = { x: origin.x + d.x * distance, y: origin.y + d.y * distance, z: origin.z + d.z * distance };
                this.effects.tracer(from, end, true);
                // Keep a quiet, movable decal; never predict blood, damage or a hit.
                const impact = this.effects.impact(end, origin, distance < w.range);
                impact.visible = distance < w.range;
                impacts.push(impact);
            }
            this.effects.shell(from, input.yaw);
            p.ammo = Math.max(0, p.ammo - 1);
        }
        this.pending.push({ seq: input.seq, weapon: p.weapon, impacts });
        if (this.pending.length > 128) this.pending.shift();
        p.bloom = Math.min(w.maxBloom, p.bloom + w.bloom);
        this.viewmodel.fire(); this.audio.shot(p.weapon);
        return recoilFor(p.weapon, index);
    }
    confirm(e: Extract<GameEvent, { type: 'shot' }>) {
        // Dropped/coalesced inputs can change which held-fire sequence the server
        // accepts. Match the nearest outstanding shot without replaying feedback.
        const candidates = this.pending.filter(p => p.weapon === e.weapon);
        const predicted = candidates.sort((a, b) => Math.abs(a.seq - e.seq) - Math.abs(b.seq - e.seq))[0];
        if (predicted) this.pending.splice(this.pending.indexOf(predicted), 1);
        if (e.weapon === 'knife') return;
        e.ends.forEach((end, i) => {
            const impact = predicted?.impacts[i];
            const distance = Math.hypot(end.x - e.origin.x, end.y - e.origin.y, end.z - e.origin.z);
            if (impact) {
                this.effects.correctImpact(impact, end, e.origin);
                impact.visible = distance < WEAPONS[e.weapon].range - .01;
            } else if (distance < WEAPONS[e.weapon].range - .01) this.effects.impact(end, e.origin, false);
        });
    }
}
