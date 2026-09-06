import { ABILITIES, abilityActive, GRENADE, grenadeDamage } from '../shared/abilities';
import { canDamage } from '../shared/combat';
import { direction, distance, worldHit } from '../shared/math';
import { eyeHeight } from '../shared/movement';
import { stepGrenade, type GrenadeBody } from '../shared/grenade';
import { STEP, type GameEvent, type Input, type Vec3 } from '../shared/types';
import type { Actor, Room } from './simulation';

interface Active { origin: Vec3; started: number; next: number; healed: number }
interface Projectile extends GrenadeBody { id: string; owner: string; until: number; simulatedAt: number; nextUpdate: number }
export class Tactics {
    active = new Map<string, Active>();
    grenades = new Map<string, Projectile>();
    private serial = 0;
    constructor(private room: Room) {}
    cancel(a: Actor) {
        a.state.abilityUntil = 0; a.state.abilitySteps = 0;
        this.active.delete(a.state.id);
    }
    cancelProjectiles(a: Actor, now: number) {
        for (const [id, g] of this.grenades) if (g.owner === a.state.id) {
            this.room.onTactical({ type: 'tactical', time: now, players: [], events: [this.event(g, now, 'cancel')] });
            this.grenades.delete(id);
        }
        a.state.grenadeUntil = 0;
    }
    clear() {
        this.grenades.clear(); this.active.clear();
        for (const a of this.room.players.values()) { this.cancel(a); a.state.grenadeUntil = 0; }
    }
    use(a: Actor, i: Input, now: number) {
        const p = a.state;
        // The input may request only the current class's tool, never its effect,
        // strength, target or cooldown. Reject stale lives and delayed commands.
        if (!a.connected || !p.alive || this.room.round.phase !== 'playing' || i.life !== p.life ||
            now - i.shotTime - (i.interpolationDelay ?? 0) > 1000 || i.shotTime > now + 250) return;
        if (i.ability && now >= (p.abilityReadyAt ?? 0) && !abilityActive(p, now) &&
            (p.classId !== 'triggerman' || p.hp < p.maxHp)) {
            const spec = ABILITIES[p.classId];
            p.abilityReadyAt = now + spec.cooldown; p.abilityUntil = now + spec.duration;
            p.abilitySteps = p.classId === 'runngun' ? Math.round(spec.duration / (STEP * 1000)) : 0;
            this.active.set(p.id, { origin: { x: p.x, y: p.y, z: p.z }, started: now, next: now + (p.classId === 'triggerman' ? 1500 : 800), healed: 0 });
            this.room.onTactical({ type: 'tactical', time: now, players: [], events: [{ type: 'ability', player: p.id, classId: p.classId, origin: { x: p.x, y: p.y, z: p.z }, until: p.abilityUntil }] });
            // Movement grants travel on the snapshot/ACK channel, so the replay
            // budget is anchored to the exact command that received the grant.
        }
        if (i.grenade && now >= (p.grenadeReadyAt ?? 0)) {
            if (p.classId === 'vince') this.cancel(a);
            p.grenadeReadyAt = now + GRENADE.cooldown; p.grenadeUntil = now + GRENADE.fuse;
            const d = direction(i.yaw, i.pitch);
            const g: Projectile = { id: `${p.id}:${++this.serial}`, owner: p.id, position: { x: p.x, y: p.y + eyeHeight(p), z: p.z },
                velocity: { x: d.x * GRENADE.speed, y: d.y * GRENADE.speed + GRENADE.lift, z: d.z * GRENADE.speed },
                until: p.grenadeUntil, simulatedAt: now, nextUpdate: now + 100 };
            this.grenades.set(g.id, g); this.flight(g, now);
        }
    }
    updateActor(a: Actor, now: number) {
        const p = a.state, active = this.active.get(p.id);
        if (!p.alive || !a.connected || this.room.round.phase !== 'playing') { this.cancel(a); return; }
        if (!active) return;
        if (p.classId === 'hunter') {
            if (distance(p, active.origin) > .6) { this.cancel(a); return; }
            if (now >= active.next && abilityActive(p, now)) {
                active.next = now + 500;
                const from = { x: p.x, y: p.y + eyeHeight(p), z: p.z };
                const facing = direction(p.yaw, p.pitch);
                const points = p.aiming ? [...this.room.players.values()].filter(q => q.connected && q.state.alive && q !== a && canDamage(p, q.state, this.room.round.mode)).flatMap(q => {
                    const to = { x: q.state.x, y: q.state.y + 1, z: q.state.z }, dist = distance(from, to);
                    const d = { x: (to.x - from.x) / dist, y: (to.y - from.y) / dist, z: (to.z - from.z) / dist };
                    return dist < 60 && facing.x * d.x + facing.y * d.y + facing.z * d.z > .5 && worldHit(from, d, dist, this.room.map) >= dist - .01 ? [to] : [];
                }) : [];
                this.room.onTactical({ type: 'tactical', time: now, players: [], events: [{ type: 'spot', viewer: p.id, life: p.life, points, until: Math.min(p.abilityUntil!, now + 550) }] }, p.id);
            }
        }
        if (p.classId === 'triggerman') {
            const before = p.hp;
            while (active.healed < 30 && now >= active.next && active.next <= p.abilityUntil!) {
                active.next += 500; active.healed += 5; p.hp = Math.min(p.maxHp, p.hp + 5);
            }
            if (p.hp !== before) this.room.onTactical({ type: 'tactical', time: now, events: [], players: [this.room.combatPatch(p)] });
        }
        if (!abilityActive(p, now)) this.cancel(a);
    }
    tick(now: number) {
        if (this.room.round.phase !== 'playing') { this.clear(); return; }
        for (const g of this.grenades.values()) {
            const owner = this.room.players.get(g.owner);
            if (!owner?.connected) {
                this.room.onTactical({ type: 'tactical', time: now, players: [], events: [this.event(g, now, 'cancel')] });
                this.grenades.delete(g.id); continue;
            }
            const end = Math.min(now, g.until);
            while (g.simulatedAt < end - 1e-6) {
                const dt = Math.min(STEP, (end - g.simulatedAt) / 1000);
                stepGrenade(g, dt, this.room.map); g.simulatedAt += dt * 1000;
            }
            if (now >= g.until) {
                this.grenades.delete(g.id); owner.state.grenadeUntil = 0;
                const start = this.room.events.length;
                this.room.events.push(this.event(g, now, 'blast'));
                const affected = new Set([owner.state]);
                for (const target of this.room.players.values()) {
                    const q = target.state;
                    if (!target.connected || !q.alive || (target !== owner && !canDamage(owner.state, q, this.room.round.mode))) continue;
                    const point = { x: q.x, y: q.y + (q.slide > 0 ? .6 : 1), z: q.z }, dist = distance(g.position, point);
                    const damage = grenadeDamage(dist);
                    if (!damage) continue;
                    const d = { x: (point.x - g.position.x) / dist, y: (point.y - g.position.y) / dist, z: (point.z - g.position.z) / dist };
                    if (dist > .001 && worldHit(g.position, d, dist, this.room.map) < dist - .01) continue;
                    this.room.damage(owner.state, q, damage, 'body', point, g.position, 'grenade', now); affected.add(q);
                }
                this.room.onTactical({ type: 'tactical', time: now, events: this.room.events.slice(start), players: [...affected].map(p => this.room.combatPatch(p)) });
            } else if (now >= g.nextUpdate) { g.nextUpdate = now + 100; this.flight(g, now); }
        }
    }
    private event(g: Projectile, now: number, phase: 'flight' | 'blast' | 'cancel'): GameEvent {
        return { type: 'grenade', id: g.id, owner: g.owner, phase, position: { ...g.position }, velocity: { ...g.velocity }, time: now, until: g.until };
    }
    private flight(g: Projectile, now: number) { this.room.onTactical({ type: 'tactical', time: now, players: [], events: [this.event(g, now, 'flight')] }); }
}
