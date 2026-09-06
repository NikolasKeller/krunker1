import { writeFile, mkdir } from 'node:fs/promises';
import { Room } from '../src/server/simulation';
import { CLASS_IDS, WEAPONS, damageFor } from '../src/shared/weapons';
import { ABILITIES, guardedDamage, grenadeDamage } from '../src/shared/abilities';
import { MAPS } from '../src/shared/map';
import { STEP, type ClassId } from '../src/shared/types';
import { random } from '../src/shared/math';

const out = new URL('../artifacts/abilities/', import.meta.url); await mkdir(out, { recursive: true });
const ttk = Object.entries(WEAPONS).map(([id, w]) => {
    const weapon = id as keyof typeof WEAPONS, damage = damageFor(weapon, 'body', weapon === 'knife' ? 2 : 5) * w.pellets;
    const hits = Math.ceil(100 / damage), guarded = Math.ceil(100 / guardedDamage({ classId: 'vince', abilityUntil: 1 }, damage, 0));
    const commandInterval = Math.ceil(w.interval / (STEP * 1000)) * STEP * 1000;
    return { weapon, bodyDamage: damage, hits, ttkMs: (hits - 1) * commandInterval, guardHits: guarded, guardTtkMs: (guarded - 1) * commandInterval,
        afterPeakGrenadeHits: Math.ceil((100 - grenadeDamage(0)) / damage), afterPeakGrenadeFollowupMs: (Math.ceil((100 - grenadeDamage(0)) / damage) - 1) * commandInterval };
});
const rounds = [];
const saved = Math.random;
try {
    for (const map of MAPS) for (const enabled of [false, true]) {
        Math.random = random(819 + MAPS.indexOf(map));
        const r = new Room('BALANCE', map.id), counts = Object.fromEntries(CLASS_IDS.map(id => [id, 0])) as Record<ClassId, number>;
        let throws = 0, grenadeKills = 0;
        for (const [n, id] of CLASS_IDS.entries()) r.add(id, id, n % 2 ? 'red' : 'blue', true);
        r.difficulty = 'normal'; r.round.duration = 120000; r.round.scoreLimit = 200; r.start(10000);
        if (!enabled) r.tactics.use = () => {};
        r.onTactical = m => {
            for (const e of m.events) {
                if (e.type === 'ability') counts[e.classId]++;
                if (e.type === 'grenade' && e.phase === 'flight' && e.until - e.time === 2200) throws++;
                if (e.type === 'kill' && e.weapon === 'grenade') grenadeKills++;
            }
        };
        const times: number[] = [];
        for (let n = 1; n <= 7200; n++) {
            const start = performance.now(); r.tick(10000 + n * STEP * 1000, false); times.push(performance.now() - start); r.events = [];
        }
        times.sort((a, b) => a - b);
        const result = { map: map.id, enabled, abilityUses: counts, grenadeThrows: throws, grenadeKills,
            players: [...r.players.values()].map(a => ({ class: a.state.classId, kills: a.state.kills, deaths: a.state.deaths, score: a.state.score })),
            tickMs: { p95: times[Math.floor(times.length * .95)], p99: times[Math.floor(times.length * .99)], max: times.at(-1) } };
        rounds.push(result); console.log(JSON.stringify(result));
    }
} finally { Math.random = saved; }
await writeFile(new URL('balance.json', out), JSON.stringify({ health: 100, abilities: ABILITIES, ttk, rounds, limitations: 'Ten seeded two-minute simulations with one bot per class. Descriptive smoke test, not a human balance study. First-hit-to-kill assumes body hits at 5m (knife 2m), all shotgun pellets connect. Grenade followup excludes the 2.2s fuse.' }, null, 2) + '\n');
