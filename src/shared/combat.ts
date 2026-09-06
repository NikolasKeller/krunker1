import { getClientMap } from './map';
import { hitPlayer, worldHit } from './math';
import { WEAPONS, damageFor } from './weapons';
import { STEP, type Input, type Mode, type PlayerState, type Vec3, type WeaponId } from './types';

export const SWITCH_MS = 180;
const stepsFor = (ms: number) => Math.ceil(ms / (STEP * 1000));
// Count simulated commands, never sequence gaps or packet arrival time. Catch-up
// cannot shorten draw/cadence or create simulation credit on the server.
export class CombatClock {
    steps = 0;
    next = 0;
    last = -Infinity;
    index = 0;
    aim = 0;
    bloom = 0;
    weapon: WeaponId;
    constructor(weapon: WeaponId) { this.weapon = weapon; }
    advance(weapon: WeaponId, input: Input, speed: number) {
        this.steps++;
        if (weapon !== this.weapon) {
            this.weapon = weapon;
            this.next = Math.max(this.next, this.steps + stepsFor(SWITCH_MS));
            this.index = 0; this.aim = 0; this.bloom = 0;
        }
        const w = WEAPONS[weapon];
        this.bloom = Math.max(0, this.bloom - w.recovery * STEP * (speed < 1 ? 1.5 : .75));
        this.aim = input.aim ? Math.min(1, this.aim + STEP * 1000 / (w.scopeTime || 1)) : 0;
        if (this.steps - this.last > stepsFor(450)) this.index = 0;
    }
    fire() {
        if (this.steps < this.next) return undefined;
        const index = this.index++;
        this.last = this.steps; this.next = this.steps + stepsFor(WEAPONS[this.weapon].interval);
        return index;
    }
    bloomAfterFire() { this.bloom = Math.min(WEAPONS[this.weapon].maxBloom, this.bloom + WEAPONS[this.weapon].bloom); }
    copy() { return Object.assign(new CombatClock(this.weapon), this); }
}
export type RayTarget = Pick<PlayerState, 'id' | 'x' | 'y' | 'z' | 'slide'>;
export type RayHit = { victim: string; damage: number; zone: 'head' | 'body' | 'legs'; point: Vec3 };
// Shared pellet aggregation, world occlusion, hitboxes, falloff and nearest-hit
// selection. The caller owns eligibility and the timeline of target poses.
export function traceShot(weapon: WeaponId, origin: Vec3, dirs: Vec3[], targets: RayTarget[], map = getClientMap()) {
    const hits = new Map<string, RayHit>();
    const ends = dirs.map(d => {
        let nearest = worldHit(origin, d, WEAPONS[weapon].range, map), victim: string | undefined, zone: RayHit['zone'] = 'body';
        for (const target of targets) {
            const hit = hitPlayer(origin, d, target);
            if (hit && hit.distance < nearest) { nearest = hit.distance; victim = target.id; zone = hit.zone; }
        }
        const point = { x: origin.x + d.x * nearest, y: origin.y + d.y * nearest, z: origin.z + d.z * nearest };
        if (victim) {
            const prev = hits.get(victim);
            hits.set(victim, { victim, damage: (prev?.damage ?? 0) + damageFor(weapon, zone, nearest), zone: prev?.zone === 'head' ? 'head' : zone, point });
        }
        return point;
    });
    return { ends, hits: [...hits.values()] };
}
export function visibleTargets(shooter: PlayerState, players: PlayerState[], mode: Mode, _now: number) {
    return players.filter(q => q.id !== shooter.id && q.alive && (mode !== 'tdm' || q.team !== shooter.team));
}

export function canDamage(shooter: Pick<PlayerState, 'team'>, victim: Pick<PlayerState, 'team'>, mode: Mode) {
    return mode !== 'tdm' || shooter.team !== victim.team;
}
