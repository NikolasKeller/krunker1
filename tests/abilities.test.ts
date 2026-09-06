import assert from 'node:assert/strict';
import test from 'node:test';
import { Room } from './sandyard-room';
import type { Actor } from '../src/server/simulation';
import { ABILITIES, GRENADE, grenadeDamage, guardedDamage } from '../src/shared/abilities';
import { moveState, neutralInput, validInput, MAX_SPEED } from '../src/shared/movement';
import { CLASS_IDS, CLASSES, damageFor, WEAPONS } from '../src/shared/weapons';
import { decodeClientMessage, encodeClientMessage, decodeServerMessage, encodeServerMessage, wireInput } from '../src/shared/protocol';
import { STEP, type Input, type ClassId, type TacticalMessage } from '../src/shared/types';
import { TacticalInput } from '../src/client/tactical-input';
import { predictInput, reconcile } from '../src/client/prediction';
import { MAPS, setClientMap, getMap } from '../src/shared/map';
import { stepGrenade } from '../src/shared/grenade';
import { botInput, brain } from '../src/server/bots';

function setup(classId: ClassId = 'vince') {
    const r = new Room('TOOLS'), a = r.add('A', classId, 'blue'), b = r.add('B', 'triggerman', 'red');
    r.botCount = 0; r.start(10000); r.events = [];
    Object.assign(a.state, moveState(34, 0, 20)); Object.assign(b.state, moveState(34, 0, 10));
    a.state.hp = 70;
    return { r, a, b };
}
function input(r: Room, a: Actor, now: number, extra: Partial<Input> = {}) {
    const i = wireInput({ ...neutralInput(a.lastSeq + 1), life: a.state.life, shotTime: now, ...extra });
    assert.equal(r.enqueue(a, [i], now), true); r.tick(now); return i;
}

for (const id of CLASS_IDS) test(`${id}: server cooldown rejects 15s reuse, forged timing/state, repeated batches and stale lives`, () => {
    const { r, a } = setup(id), start = 11000;
    input(r, a, start, { ability: true });
    const ready = start + ABILITIES[id].cooldown;
    assert.equal(a.state.abilityReadyAt, ready);
    assert.equal(a.state.abilityUntil, start + ABILITIES[id].duration);
    input(r, a, start + 15000, { ability: true, shotTime: ready + 100000 });
    input(r, a, ready - 1, { ability: true });
    assert.equal(a.state.abilityReadyAt, ready); assert.equal(a.state.abilityUntil, 0);
    input(r, a, ready, { ability: true, life: a.state.life - 1 });
    assert.equal(a.state.abilityReadyAt, ready);
    input(r, a, ready + 1, { ability: true, shotTime: ready - 2000 });
    assert.equal(a.state.abilityReadyAt, ready);
    a.state.hp = 60;
    const batch = Array.from({ length: 12 }, (_, n) => ({ ...neutralInput(a.lastSeq + n + 1), life: a.state.life, shotTime: ready + 2, ability: true, abilityReadyAt: 0, abilityUntil: 999999999, classId: 'vince' }));
    a.credit = 12; assert.ok(r.enqueue(a, batch, ready + 2)); r.tick(ready + 2);
    assert.equal(a.state.abilityReadyAt, ready + 2 + ABILITIES[id].cooldown);
    assert.equal(a.state.classId, id);
});

for (const id of CLASS_IDS) test(`${id}: death, respawn, class/team changes retain cooldown; round end cancels; rematch resets`, () => {
    const { r, a, b } = setup(id);
    input(r, a, 11000, { ability: true, grenade: true });
    const ready = a.state.abilityReadyAt, grenadeReady = a.state.grenadeReadyAt;
    r.damage(b.state, a.state, 1000, 'body', a.state, b.state, 'rifle', 11001);
    assert.equal(a.state.abilityUntil, 0); assert.equal(a.state.abilitySteps, 0);
    assert.equal(r.tactics.grenades.size, 1, 'a thrown grenade survives its owner dying');
    input(r, a, 11002, { ability: true, grenade: true });
    assert.equal(a.state.abilityReadyAt, ready); assert.equal(a.state.grenadeReadyAt, grenadeReady);
    const respawnAt = a.state.respawnAt;
    r.changeClass(a, id === 'hunter' ? 'runngun' : 'hunter', 11003);
    assert.equal(a.state.alive, false); assert.equal(a.state.respawnAt, respawnAt);
    assert.equal(r.tactics.grenades.size, 0, 'selection cancels launched ordnance');
    r.spawn(a, 14000); input(r, a, 14001, { ability: true, grenade: true });
    r.moveTeam(a.state.id, a.state.id, 'red', 14002);
    assert.equal(a.state.abilityReadyAt, ready); assert.equal(a.state.grenadeReadyAt, grenadeReady);
    r.round.endsAt = 15000; r.tick(15000);
    assert.equal(r.round.phase, 'results'); assert.equal(a.state.abilityUntil, 0); assert.equal(r.tactics.grenades.size, 0);
    input(r, a, 16000, { ability: true, grenade: true }); assert.equal(a.state.abilityReadyAt, ready);
    r.start(20000); assert.equal(a.state.abilityReadyAt, 0); assert.equal(a.state.grenadeReadyAt, 0);
});

test('grenade requests cannot borrow a future cooldown or client-supplied damage and reject invalid flags', () => {
    const { r, a } = setup(); input(r, a, 11000, { grenade: true });
    const ready = a.state.grenadeReadyAt;
    input(r, a, 26000, { grenade: true }); assert.equal(a.state.grenadeReadyAt, ready); assert.equal(r.tactics.grenades.size, 0);
    input(r, a, ready! - 1, { grenade: true }); assert.equal(r.tactics.grenades.size, 0);
    input(r, a, ready!, { grenade: true }); assert.equal(r.tactics.grenades.size, 1);
    assert.equal(validInput({ ...neutralInput(), grenade: 1 }), false);
    assert.equal(validInput({ ...neutralInput(), ability: 'vince' }), false);
    const i = { ...neutralInput(5), life: 2, combat: true, ability: true, grenade: true };
    assert.deepEqual(decodeClientMessage(encodeClientMessage({ type: 'input', inputs: [i] })), { type: 'input', inputs: [i] });
});

test('client gate suppresses early, repeated, dead, class-selection and round-end requests without granting outcomes', () => {
    const { a } = setup('runngun'), p = a.state, gate = new TacticalInput();
    const request = { ...neutralInput(10), ability: true, grenade: true };
    p.abilityReadyAt = p.grenadeReadyAt = 60000;
    const before = { ...p };
    assert.equal(gate.prepare(request, p, true, 59999).ability, undefined);
    assert.equal(gate.prepare(request, p, true, 59999).grenade, undefined);
    assert.deepEqual(p, before, 'the client cannot grant HP, movement or cooldown');
    assert.equal(gate.prepare(request, p, true, 60000).ability, true);
    assert.equal(gate.prepare({ ...request, seq: 11 }, p, true, 60001).ability, undefined);
    p.ack = 10; p.abilityReadyAt = p.grenadeReadyAt = 120000;
    assert.equal(gate.prepare(request, p, true, 61000).grenade, undefined);
    p.life++; p.alive = false;
    assert.equal(gate.prepare(request, p, true, 120000).ability, undefined);
    p.alive = true;
    assert.equal(gate.prepare(request, p, false, 120000).ability, undefined);
    assert.equal(gate.prepare(request, p, true, 120000).ability, true);
});

test('Second Wind heals only 30, caps at 100, needs injury, and damage interrupts recovery', () => {
    const { r, a, b } = setup('triggerman'); a.state.hp = 50;
    input(r, a, 11000, { ability: true }); r.tick(12499); assert.equal(a.state.hp, 50);
    r.tick(12500); assert.equal(a.state.hp, 55);
    r.damage(b.state, a.state, 10, 'body', a.state, b.state, 'rifle', 12501);
    r.tick(15000); assert.equal(a.state.hp, 45); assert.equal(a.state.abilityUntil, 0);
    a.state.abilityReadyAt = 0; input(r, a, 16000, { ability: true }); r.tick(20000); assert.equal(a.state.hp, 75);
    a.state.abilityReadyAt = 0; a.state.hp = 90; input(r, a, 21000, { ability: true }); r.tick(25000); assert.equal(a.state.hp, 100);
    a.state.abilityReadyAt = 0; input(r, a, 26000, { ability: true }); assert.equal(a.state.abilityReadyAt, 0);
});

test('Breach Guard reduces damage once per aggregated shot, ends before firing or throwing, and does not increase HP', () => {
    const { r, a, b } = setup(); a.state.hp = 100;
    input(r, a, 11000, { ability: true });
    r.damage(b.state, a.state, 42, 'body', a.state, b.state, 'rifle', 11001);
    assert.equal(a.state.hp, 72); assert.equal(a.state.maxHp, 100);
    input(r, a, 11100, { fire: true }); assert.equal(a.state.abilityUntil, 0);
    a.state.abilityReadyAt = 0; input(r, a, 12000, { ability: true, grenade: true }); assert.equal(a.state.abilityUntil, 0);
    assert.equal(guardedDamage({ classId: 'vince', abilityUntil: 15000 }, 416, 14000), 271);
});

test('Watchpoint only reports unobstructed enemies to its owner, requires aiming/arming, and moving cancels it', () => {
    const { r, a, b } = setup('hunter'), messages: { m: TacticalMessage; recipient?: string }[] = [];
    r.onTactical = (m, recipient) => messages.push({ m, recipient });
    input(r, a, 11000, { ability: true, aim: true }); r.tick(11799);
    assert.equal(messages.some(x => x.m.events.some(e => e.type === 'spot')), false);
    r.tick(11800);
    const spot = messages.find(x => x.m.events.some(e => e.type === 'spot'))!;
    assert.equal(spot.recipient, a.state.id); assert.equal((spot.m.events[0] as Extract<typeof spot.m.events[number], { type: 'spot' }>).points.length, 1);
    // Opponent behind the solid central house, not the open perimeter lane.
    Object.assign(b.state, moveState(-19, 0, 0)); r.tick(12300);
    const last = messages.at(-1)!.m.events[0]; assert.ok(last.type === 'spot'); assert.equal(last.points.length, 0);
    a.state.x -= 1; r.tick(12301); assert.equal(a.state.abilityUntil, 0);
});

test('grenade arc rises, falls, bounces on thin walls, and stops at ramps and world bounds', () => {
    const base = getMap('sandyard');
    const map = { ...base, boxes: [{ ...base.boxes[0], x: 0, y: 2, z: 0, w: .02, h: 4, d: 8 }], ramps: [] };
    const g = { position: { x: -2, y: 1.6, z: 0 }, velocity: { x: 18, y: 5, z: 0 } };
    let high = g.position.y;
    for (let n = 0; n < 132; n++) { stepGrenade(g, STEP, map); high = Math.max(high, g.position.y); assert.ok(g.position.x <= -.13 + 1e-8); assert.ok(g.position.y >= GRENADE.size - 1e-8); }
    assert.ok(high > 1.9); assert.ok(g.position.y < high);
    for (const map of MAPS) for (const ramp of map.ramps) {
        const g = { position: { x: ramp.x, y: ramp.h + 3, z: ramp.z }, velocity: { x: 0, y: -20, z: 0 } };
        for (let n = 0; n < 30; n++) stepGrenade(g, STEP, map);
        assert.ok(g.position.y >= ramp.h / 2, map.id + ': never below ramp surface');
    }
});

test('grenade fuse, radius, falloff, cover, self damage, friendly fire and kill credit use server outcomes', () => {
    const { r, a, b } = setup(); const friendly = r.add('Friend', 'hunter', 'blue');
    r.round.mode = 'tdm'; a.state.hp = b.state.hp = friendly.state.hp = 100;
    input(r, a, 11000, { grenade: true });
    const g = [...r.tactics.grenades.values()][0];
    // Deterministic explosion at an explicit legal point isolates blast geometry.
    g.position = { x: 34, y: 1, z: 10 }; g.velocity = { x: 0, y: 0, z: 0 }; g.simulatedAt = g.until;
    Object.assign(friendly.state, moveState(34, 0, 10));
    r.tick(13199); assert.equal(b.state.hp, 100);
    r.tick(13200); assert.equal(b.state.hp, 35); assert.equal(friendly.state.hp, 100); assert.equal(a.state.hp, 100);
    assert.equal(grenadeDamage(0), 65); assert.equal(grenadeDamage(3), 32); assert.equal(grenadeDamage(6), 0); assert.equal(grenadeDamage(7), 0);
    a.state.grenadeReadyAt = 0; input(r, a, 14000, { grenade: true });
    const next = [...r.tactics.grenades.values()][0]; next.position = { x: 34, y: 1, z: 10 }; next.simulatedAt = next.until;
    r.tick(16200); assert.equal(b.state.alive, false); assert.equal(a.state.kills, 1); assert.equal(r.round.blue, 1);
    assert.ok(r.events.some(e => e.type === 'kill' && e.weapon === 'grenade'));
    a.state.grenadeReadyAt = 0; a.state.hp = 30; input(r, a, 17000, { grenade: true });
    const self = [...r.tactics.grenades.values()][0]; self.position = { x: a.state.x, y: a.state.y + 1, z: a.state.z }; self.simulatedAt = self.until;
    r.tick(19200); assert.equal(a.state.alive, false); assert.equal(a.state.kills, 1); assert.equal(r.round.blue, 1);
    // A thin solid wall prevents a blast at two metres, despite close range.
    const covered = setup(), wall = covered.r.map.boxes.find(b => b.kind === 'crate')!;
    Object.assign(covered.b.state, moveState(wall.x + wall.w / 2 + .4, wall.y - wall.h / 2, wall.z));
    input(covered.r, covered.a, 11000, { grenade: true });
    const blast = [...covered.r.tactics.grenades.values()][0]; blast.position = { x: wall.x - wall.w / 2 - .2, y: wall.y, z: wall.z }; blast.simulatedAt = blast.until;
    covered.r.tick(13200); assert.equal(covered.b.state.hp, 100);
});

for (const map of MAPS) test(`${map.name}: Overrun replay agrees with server while using collision and preserving the speed cap`, () => {
    const r = new Room('BOOST'); r.round.mapId = map.id; setClientMap(map.id);
    try {
        const a = r.add('Runner', 'runngun', 'blue'); r.start(10000);
        input(r, a, 11000, { ability: true });
        const snapshot = decodeServerMessage(encodeServerMessage({ type: 'snapshot', n: 1, base: 0, time: 11000, full: true, players: [{ ...a.state }], removed: [] }, a.state.id));
        assert.ok(snapshot.type === 'snapshot');
        const local = { ...a.state }, pending: Input[] = [];
        for (let n = 1; n <= 170; n++) {
            const i = input(r, a, 11000 + n * STEP * 1000, { forward: 1, strafe: 1, yaw: .7, jump: n % 45 === 0, slide: n % 45 > 35 });
            predictInput(local, i, true); pending.push(i);
            assert.ok(Math.hypot(a.state.vx, a.state.vz) <= MAX_SPEED + 1e-8);
            for (const key of ['x', 'y', 'z', 'vx', 'vy', 'vz', 'abilitySteps'] as const) assert.equal(local[key], a.state[key], `${map.id} ${n} ${key}`);
        }
        const replay = reconcile(snapshot.players[0] as typeof local, pending, true).predicted;
        assert.equal(replay.x, a.state.x); assert.equal(replay.y, a.state.y); assert.equal(replay.z, a.state.z);
        r.tick(14000); assert.equal(a.state.abilitySteps, 0, 'withheld inputs cannot bank speed after the wall-clock duration');
    } finally { setClientMap('sandyard'); }
});

test('bots use class abilities after difficulty-dependent reaction delays and obey the same cooldown', () => {
    for (const classId of CLASS_IDS) for (const difficulty of ['easy', 'normal', 'hard'] as const) {
        const { r, a, b } = setup(classId), bot = brain(); a.state.hp = 50;
        Object.assign(a.state, moveState(34, 0, 30)); Object.assign(b.state, moveState(34, 0, 10));
        botInput(a.state, bot, [a.state, b.state], 'ffa', difficulty, 11000, r.map);
        const before = botInput(a.state, bot, [a.state, b.state], 'ffa', difficulty, 11500, r.map); assert.ok(!before.ability);
        const due = 11000 + { easy: 3500, normal: 1800, hard: 800 }[difficulty];
        const chosen = botInput(a.state, bot, [a.state, b.state], 'ffa', difficulty, due, r.map); assert.equal(chosen.ability, true, classId + difficulty);
        r.tactics.use(a, chosen, due); assert.ok(a.state.abilityReadyAt! > due + 45000);
        const repeated = botInput(a.state, bot, [a.state, b.state], 'ffa', difficulty, due + 16000, r.map); assert.ok(!repeated.ability);
    }
});

test('damage balance at 100 HP preserves sniper/shotgun lethality and guard adds only one rifle/SMG body hit', () => {
    const guard = { classId: 'vince' as const, abilityUntil: 1000 };
    for (const [weapon, normal, guarded] of [['rifle', 3, 4], ['smg', 4, 5], ['sniper', 1, 1], ['shotgun', 1, 1]] as const) {
        const damage = damageFor(weapon, 'body', 5) * WEAPONS[weapon].pellets;
        assert.equal(Math.ceil(100 / damage), normal); assert.equal(Math.ceil(100 / guardedDamage(guard, damage, 0)), guarded);
    }
    const { a } = setup('runngun'), normal = { ...a.state, ...moveState(34, 0, 30) }, fast = { ...normal, abilitySteps: 180 };
    for (let n = 0; n < 60; n++) { const i = { ...neutralInput(n), forward: 1 }; predictInput(normal, i, true); predictInput(fast, i, true); }
    assert.ok(Math.hypot(fast.vx, fast.vz) / Math.hypot(normal.vx, normal.vz) > 1.3, 'Overrun must actually overcome ground friction');
    assert.equal(CLASSES.vince.hp, 100);
});
