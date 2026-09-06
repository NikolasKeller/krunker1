import { writeFileSync } from 'node:fs';
import { Room } from '../src/server/simulation';
import { SOLID_BOXES, RAMPS } from '../src/shared/map';
import { moveState, neutralInput, eyeHeight } from '../src/shared/movement';
import { random } from '../src/shared/math';
import { CombatClock, traceShot } from '../src/shared/combat';
import { WEAPONS, shotRays, damageFor } from '../src/shared/weapons';
import { STEP, type Difficulty, type WeaponId } from '../src/shared/types';

// Controlled open-arena experiment: actual server bot perception, movement,
// firing, recoil, spread, reloads and damage. No browser or player telemetry.
SOLID_BOXES.length = 0; RAMPS.length = 0;
const samples = Number(process.env.BALANCE_SAMPLES ?? 300);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const bots = [];
const originalRandom = Math.random;
try {
    for (const difficulty of ['easy', 'normal', 'hard'] as Difficulty[]) for (const moving of [false, true]) {
        let shots = 0, hits = 0, heads = 0, timeouts = 0;
        const ttk: number[] = [], firingTtk: number[] = [], reactions: number[] = [];
        for (let trial = 0; trial < samples; trial++) {
            Math.random = random(7103 + trial);
            const room = new Room('BENCH'); room.botCount = 0; room.difficulty = difficulty; room.round.mode = 'tdm';
            const bot = room.add('Bot', 'triggerman', 'blue', true), target = room.add('Target', 'triggerman', 'red');
            room.start(0);
            Object.assign(bot.state, moveState(0, 0, 18), { yaw: 0, pitch: 0, ack: trial * 2000 });
            Object.assign(target.state, moveState(0, 0, 0), { hp: 100, maxHp: 100 });
            let firstShot = -1;
            for (let tick = 1; tick <= 1200; tick++) {
                const elapsed = tick * STEP, now = 1000 + elapsed * 1000;
                if (moving) {
                    // Starts centred, strafes at 6 m/s, reverses at +/-4 m.
                    const phase = (elapsed * 6 + 4) % 16;
                    target.state.x = phase <= 8 ? phase - 4 : 12 - phase;
                    target.state.vx = phase <= 8 ? 6 : -6;
                }
                room.events = []; room.tick(now, false);
                for (const e of room.events) {
                    if (e.type === 'shot') { shots++; if (firstShot < 0) firstShot = elapsed * 1000; }
                    if (e.type === 'hit') { hits++; if (e.zone === 'head') heads++; }
                }
                if (!target.state.alive) {
                    ttk.push(elapsed * 1000); firingTtk.push(elapsed * 1000 - firstShot); reactions.push(firstShot); break;
                }
                if (tick === 1200) timeouts++;
            }
        }
        bots.push({ difficulty, target: moving ? 'moving' : 'stationary', trials: samples, shots, hits, accuracyPercent: hits / shots * 100,
            headshotsPercentOfHits: heads / hits * 100, meanEncounterTtkMs: mean(ttk), meanFirstShotToKillMs: mean(firingTtk), meanFirstShotMs: mean(reactions), timeouts });
    }
} finally { Math.random = originalRandom; }

const shotgun = [];
for (const distance of [2, 5, 8, 12, 25, 33]) for (const speed of [0, 28]) {
    let firstDamage = 0, oneShots = 0, timeouts = 0;
    const ttk: number[] = [], counts: number[] = [];
    const outOfRange = distance - .4 > WEAPONS.shotgun.range;
    for (let trial = 0; trial < samples; trial++) {
        if (outOfRange) continue;
        const w = WEAPONS.shotgun, clock = new CombatClock('shotgun'), origin = { x: 0, y: 1.62, z: distance };
        let hp = 100, ammo = w.magazine, reloadAt = 0, shots = 0;
        for (let tick = 0; tick <= 7200; tick++) {
            const now = tick * STEP * 1000, seq = trial * 2000 + tick + 1;
            const i = { ...neutralInput(seq), pitch: Math.atan2(1 - eyeHeight({ slide: 0 }), distance) };
            clock.advance('shotgun', i, speed);
            if (reloadAt && now >= reloadAt) { ammo = w.magazine; reloadAt = 0; }
            if (!reloadAt) {
                const index = clock.fire();
                if (index !== undefined) {
                    const result = traceShot('shotgun', origin, shotRays('shotgun', 0, i.pitch, speed, clock.bloom, 0, index, seq, 2), [{ id: 'target', x: 0, y: 0, z: 0, slide: 0 }]);
                    const damage = result.hits[0]?.damage ?? 0;
                    if (!shots) { firstDamage += damage; if (damage >= 100) oneShots++; }
                    hp -= damage; shots++; clock.bloomAfterFire();
                    if (--ammo === 0) reloadAt = now + w.reload;
                    if (hp <= 0) { ttk.push(now); counts.push(shots); break; }
                }
            }
            if (tick === 7200) timeouts++;
        }
    }
    shotgun.push({ distance, speed, trials: samples, meanFirstShotDamage: firstDamage / samples, oneShotPercent: oneShots / samples * 100,
        meanTtkMs: ttk.length ? mean(ttk) : null, meanShots: counts.length ? mean(counts) : null, timeouts, outOfRange });
}
const weapons = (Object.keys(WEAPONS) as WeaponId[]).flatMap(weapon => [2, 12, 25, 50].map(distance => {
    const w = WEAPONS[weapon];
    const zones = (['body', 'head', 'legs'] as const).map(zone => {
        const damage = damageFor(weapon, zone, distance) * w.pellets, shots = damage ? Math.ceil(100 / damage) : null;
        return { zone, damage, shots, ttkMs: shots ? (shots - 1) * Math.ceil(w.interval / (STEP * 1000)) * STEP * 1000 : null };
    });
    return { weapon, distance, zones };
}));
const report = { samples, method: '100 HP. Seeded paired open-arena server rifle bot duels, start at 18 m, bot moves normally; moving target strafes +/-4 m at 6 m/s. Bot TTK starts on exposure; failures censored at 20 s and separately counted. Shotgun: torso-centred hip fire with production spread/recoil/cadence/reload, first shot at t=0, failures censored at 120 s. Stationary target, shooter speed held for spread. Out-of-range targets cannot die. Weapon table assumes every pellet hits and excludes reload.', bots, shotgun, weapons };
writeFileSync(process.env.BALANCE_REPORT ?? '/tmp/balance-report.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ bots, shotgun }, null, 2));
