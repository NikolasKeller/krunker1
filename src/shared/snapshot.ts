import type { PlayerPatch, PlayerState } from './types';

// Remote rendering needs no input acknowledgements, movement buffers or reload/ammo internals.
const visibleFields = ['id', 'name', 'classId', 'team', 'bot', 'ready', 'x', 'y', 'z', 'vx', 'vy', 'vz', 'yaw', 'pitch', 'slide', 'grounded', 'alive', 'hp', 'maxHp', 'kills', 'deaths', 'score', 'weapon', 'aiming', 'life'] as const;
const roundTo = (n: number, scale: number) => Math.round(n * scale) / scale;
export function wirePlayer(p: PlayerState, self: boolean): PlayerPatch {
    const value: PlayerPatch = self ? { ...p } : Object.fromEntries(visibleFields.map(key => [key, p[key]])) as PlayerPatch;
    for (const key of ['x', 'y', 'z', 'vx', 'vy', 'vz'] as const) value[key] = roundTo(p[key], self ? 10000 : 100);
    for (const key of ['yaw', 'pitch'] as const) value[key] = roundTo(p[key], 1000);
    value.slide = roundTo(p.slide, 10000);
    if (self) {
        for (const key of ['groundTime', 'jumpBuffer', 'coyote', 'slideAge', 'bloom'] as const) value[key] = roundTo(p[key], 1000000);
    }
    return value;
}
export function playerDelta(next: PlayerPatch, before?: PlayerPatch): PlayerPatch | undefined {
    if (!before) return next;
    const patch: PlayerPatch = { id: next.id };
    let changed = false;
    for (const key of Object.keys(next) as (keyof PlayerState)[]) {
        if (next[key] !== before[key]) {
            (patch as Record<string, unknown>)[key] = next[key];
            changed = true;
        }
    }
    return changed ? patch : undefined;
}
