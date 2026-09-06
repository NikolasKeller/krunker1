import type { ClassId, PlayerState } from './types';

export const ABILITIES: Record<ClassId, { name: string; cooldown: number; duration: number; hint: string }> = {
    hunter: { name: 'WATCHPOINT', cooldown: 60000, duration: 10000, hint: 'Aim from this position · spots clear sightlines after 0.8s' },
    triggerman: { name: 'SECOND WIND', cooldown: 70000, duration: 4000, hint: 'Recover up to 30 HP · damage interrupts' },
    vince: { name: 'BREACH GUARD', cooldown: 75000, duration: 4000, hint: '35% less incoming damage · attacking ends guard' },
    runngun: { name: 'OVERRUN', cooldown: 50000, duration: 3000, hint: '+35% running speed · normal momentum limit' },
};
export const GRENADE = { cooldown: 60000, fuse: 2200, radius: 6, damage: 65, speed: 18, lift: 5, gravity: 18, size: .12 } as const;
export function abilityActive(p: Pick<PlayerState, 'abilityUntil'>, now: number) { return (p.abilityUntil ?? 0) > now; }
export function guardedDamage(p: Pick<PlayerState, 'classId' | 'abilityUntil'>, damage: number, now: number) {
    return p.classId === 'vince' && abilityActive(p, now) ? Math.ceil(damage * .65) : damage;
}
// Only a server-granted command budget changes locomotion. Replay consumes the
// same steps; sequence gaps and client-supplied timestamps grant no extra speed.
export function abilityMoveScale(p: PlayerState) {
    if (p.classId !== 'runngun' || !(p.abilitySteps! > 0)) return 1;
    p.abilitySteps!--;
    return 1.35;
}
export function grenadeDamage(distance: number) { return Math.max(0, Math.floor(GRENADE.damage * (1 - distance / GRENADE.radius))); }
