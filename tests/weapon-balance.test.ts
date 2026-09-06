import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFileSync } from 'node:fs';
import { CLASS_IDS, CLASSES, damageFor, WEAPONS } from '../src/shared/weapons';
import { CombatClock } from '../src/shared/combat';
import { neutralInput } from '../src/shared/movement';
import { STEP, type WeaponId } from '../src/shared/types';

// Frozen values from base 5c3d7d0ebe1c16bd307ddaa8e5d1caa354462340.
const before = { sniper: 110, rifle: 25, shotgun: 24, smg: 18, pistol: 24, knife: 65 };
const expectedShots = { sniper: 1, rifle: 3, shotgun: 1, smg: 4, pistol: 3, knife: 2 };
const reports: unknown[] = [];
for (const weapon of Object.keys(WEAPONS) as WeaponId[]) test(`${weapon}: measured first-hit-to-kill timing at the shared 100 HP cap`, () => {
    const w = WEAPONS[weapon], distance = weapon === 'knife' ? 2 : 5;
    // The existing knife falloff path applies its 0.5 floor throughout melee range.
    const oldAppliedDamage = weapon === 'knife' ? Math.round(before[weapon] * .5) : before[weapon];
    const shots = Math.ceil(100 / (damageFor(weapon, 'body', distance) * w.pellets));
    assert.equal(shots, expectedShots[weapon]);
    assert.equal(shots, Math.ceil(60 / (oldAppliedDamage * w.pellets)), 'preserves the former Hunter shot count');
    const clock = new CombatClock(weapon); let hits = 0, first = -1, last = 0;
    for (let tick = 0; hits < shots; tick++) {
        clock.advance(weapon, neutralInput(tick), 0);
        if (clock.fire() !== undefined) { if (first < 0) first = tick; last = tick; hits++; }
    }
    const measuredMs = (last - first) * STEP * 1000;
    const effectiveIntervalMs = Math.ceil(w.interval / (STEP * 1000)) * STEP * 1000;
    assert.ok(Math.abs(measuredMs - (shots - 1) * effectiveIntervalMs) < 1e-8);
    reports.push({ weapon, oldDamage: before[weapon], newDamage: w.damage, oldAppliedDamage, newAppliedDamage: damageFor(weapon, 'body', distance), distanceMetres: distance, pelletsHit: w.pellets,
        before: [60, 100].map(hp => { const count = Math.ceil(hp / (oldAppliedDamage * w.pellets)); return { hp, shots: count, nominalTtkMs: (count - 1) * w.interval, commandTtkMs: (count - 1) * effectiveIntervalMs }; }),
        after: { hp: 100, shots, nominalTtkMs: (shots - 1) * w.interval, measuredCommandTtkMs: measuredMs },
        zoneShots: (['head', 'body', 'legs'] as const).map(zone => ({ zone, damage: damageFor(weapon, zone, distance), shots: Math.ceil(100 / (damageFor(weapon, zone, distance) * w.pellets)) })) });
});
test('every class starts and caps at 100 HP', () => { for (const id of CLASS_IDS) assert.equal(CLASSES[id].hp, 100); });
test.after(() => { if (process.env.BALANCE_REPORT) writeFileSync(process.env.BALANCE_REPORT, JSON.stringify(reports, null, 2) + '\n'); });
