import type { Object3D } from 'three';
import type { CombatMessage, GameEvent, Input, Mode, PlayerState, Vec3, WeaponId } from '../shared/types';
import { shotRays, recoilFor, WEAPONS } from '../shared/weapons';
import { eyeHeight } from '../shared/movement';
import { worldHit } from '../shared/math';
import { traceShot, visibleTargets, type RayHit } from '../shared/combat';
import type { Effects } from './effects';

export type ProvisionalHit = Extract<GameEvent, { type: 'hit' }> & { key: string };
export class ShotFeedback {
    onHit: (hit: ProvisionalHit) => void = () => {};
    onRetract: (key: string) => void = () => {};
    onConfirm: (key: string, hit: Extract<GameEvent, { type: 'hit' }>) => void = () => {};
    private suppressed = new WeakSet<GameEvent>();
    private compared = 0;
    private disagreements = 0;
    private rejected = 0;
    private unconfirmed = 0;
    get metrics() { return { compared: this.compared, disagreements: this.disagreements, disagreementRate: this.compared ? this.disagreements / this.compared : 0, rejected: this.rejected, unconfirmed: this.unconfirmed, pending: this.pending.length }; }
    private pending: { seq: number; life: number; shooter: string; created: number; hits: RayHit[]; weapon: WeaponId; impacts: Object3D[] }[] = [];
    constructor(private effects: Effects, private viewmodel: { fire(): void }, private audio: { shot(w: WeaponId): void; hit?(head: boolean, lethal: boolean): void }) {}
    clear() {
        for (const p of this.pending) for (const h of p.hits) this.onRetract(`${p.life}:${p.seq}:${h.victim}`);
        this.unconfirmed += this.pending.length; this.pending = [];
    }
    expire(now = performance.now()) {
        while (this.pending.length && now - this.pending[0].created > 10000) {
            const p = this.pending.shift()!; this.unconfirmed++;
            for (const h of p.hits) this.onRetract(`${p.life}:${p.seq}:${h.victim}`);
        }
    }
    resolve(m: CombatMessage) {
        const p = this.pending.find(p => p.life === m.life && p.seq === m.seq && p.shooter === m.shooter);
        if (!p) return;
        const hits = m.events.filter((e): e is Extract<GameEvent, { type: 'hit' }> => e.type === 'hit');
        this.compared++;
        if (!m.accepted) this.rejected++;
        const same = m.accepted && p.hits.length === hits.length && p.hits.every(h => hits.some(e => e.victim === h.victim && e.zone === h.zone && (e.damage === h.damage || (e.lethal && e.damage <= h.damage))));
        if (!same) this.disagreements++;
        for (const h of p.hits) {
            const key = `${p.life}:${p.seq}:${h.victim}`;
            const e = hits.find(e => e.victim === h.victim);
            if (e) { this.suppressed.add(e); this.onConfirm(key, e); }
            else this.onRetract(key);
        }
        const shot = m.events.find(e => e.type === 'shot');
        if (shot?.type === 'shot') { this.confirm(shot); this.suppressed.add(shot); }
        else this.pending.splice(this.pending.indexOf(p), 1);
    }
    reconcileEvent(e: GameEvent) { return this.suppressed.has(e); }
    fire(p: PlayerState, input: Input, index: number, aimProgress: number, muzzle: Vec3, remotes: PlayerState[] = [], mode: Mode = 'ffa', now = Date.now()) {
        if (!input.fire) return;
        const w = WEAPONS[p.weapon], origin = { x: p.x, y: p.y + eyeHeight(p), z: p.z };
        const dirs = shotRays(p.weapon, input.yaw, input.pitch, Math.hypot(p.vx, p.vz), p.bloom, aimProgress, index, input.seq, p.life);
        const trace = traceShot(p.weapon, origin, dirs, visibleTargets(p, remotes, mode, now));
        const impacts: Object3D[] = [];
        if (p.weapon !== 'knife') {
            // The eye determines the aim ray; the tracer starts at the rendered
            // muzzle. A close wall can occlude the muzzle too.
            const dx = muzzle.x - origin.x, dy = muzzle.y - origin.y, dz = muzzle.z - origin.z, length = Math.hypot(dx, dy, dz);
            const reach = length ? worldHit(origin, { x: dx / length, y: dy / length, z: dz / length }, length) / length : 1;
            const from = { x: origin.x + dx * reach, y: origin.y + dy * reach, z: origin.z + dz * reach };
            for (const end of trace.ends) {
                const distance = Math.hypot(end.x - origin.x, end.y - origin.y, end.z - origin.z);
                this.effects.tracer(from, end, true);
                // Impacts move quietly when authority resolves the exact shot.
                const impact = this.effects.impact(end, origin, distance < w.range);
                impact.visible = distance < w.range;
                impacts.push(impact);
            }
            this.effects.shell(from, input.yaw);
            p.ammo = Math.max(0, p.ammo - 1);
        }
        this.pending.push({ seq: input.seq, life: p.life, shooter: p.id, created: performance.now(), hits: trace.hits, weapon: p.weapon, impacts });
        if (this.pending.length > 600) { this.pending.shift(); this.unconfirmed++; }
        for (const hit of trace.hits) {
            this.onHit({ type: 'hit', ...hit, key: `${p.life}:${input.seq}:${hit.victim}`, shooter: p.id, from: origin, lethal: false });
            this.audio.hit?.(hit.zone === 'head', false);
        }
        p.bloom = Math.min(w.maxBloom, p.bloom + w.bloom);
        this.viewmodel.fire(); this.audio.shot(p.weapon);
        return recoilFor(p.weapon, index);
    }
    confirm(e: Extract<GameEvent, { type: 'shot' }>) {
        if (this.suppressed.has(e)) return;
        const predicted = this.pending.find(p => p.seq === e.seq && p.shooter === e.shooter && p.weapon === e.weapon);
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
