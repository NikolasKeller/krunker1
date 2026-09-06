import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { Room } from './sandyard-room';
import { neutralInput } from '../src/shared/movement';
import { STEP } from '../src/shared/types';
const r = new Room('SOAK'), a = r.add('Observer', 'triggerman', 'blue');
r.botCount = 7;
r.fillBots(0);
r.start(0);
const start = performance.now();
let events = 0, hits = 0, kills = 0, maxMs = 0;
const moved = new Map<string, number>();
for (let n = 0; n < 60 * 120; n++) {
    const now = n * STEP * 1000;
    r.enqueue(a, [neutralInput(n + 1)], now);
    const t = performance.now();
    r.tick(now);
    maxMs = Math.max(maxMs, performance.now() - t);
    for (const bot of r.players.values()) {
        const p = bot.state;
        assert.ok(Number.isFinite(p.x + p.y + p.z + p.vx + p.vy + p.vz));
        assert.ok(p.hp >= 0 && p.hp <= p.maxHp);
        if (p.bot && Math.hypot(p.vx, p.vz) > 1)
            moved.set(p.id, (moved.get(p.id) ?? 0) + 1);
    }
    events += r.events.length;
    hits += r.events.filter(e => e.type === 'hit').length;
    kills += r.events.filter(e => e.type === 'kill').length;
    r.events = [];
}
const elapsed = performance.now() - start;
assert.equal(moved.size, 7);
assert.ok(hits > 30 && kills > 5, `combat too quiet: ${hits} hits, ${kills} kills`);
console.log(JSON.stringify({ simulatedSeconds: 120, simulationMs: Math.round(elapsed), meanTickMs: +(elapsed / 7200).toFixed(3), peakTickMs: +maxMs.toFixed(3), events, hits, kills, botsMoving: moved.size }, null, 2));
