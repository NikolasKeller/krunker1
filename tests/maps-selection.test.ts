import assert from 'node:assert/strict';
import test from 'node:test';
import { MAPS, chooseMap, getMap, setClientMap } from '../src/shared/map';
import { Room } from '../src/server/simulation';
import { neutralInput } from '../src/shared/movement';
import { predictInput, PredictionHistory, reconcile } from '../src/client/prediction';
import { encodeServerMessage, decodeServerMessage, wireInput } from '../src/shared/protocol';
import { STEP } from '../src/shared/types';
import { botInput, findPath } from '../src/server/bots';
import { moveState } from '../src/shared/movement';
import { CLASS_IDS } from '../src/shared/weapons';

test('random is the default and all five maps occupy equal selection intervals', () => {
    const room = new Room('DEFAULT');
    assert.equal(room.round.mapChoice, 'random');
    const counts = new Map<string, number>();
    for (let i = 0; i < 1000; i++) {
        const id = chooseMap('random', () => (i + .5) / 1000);
        counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    assert.deepEqual([...counts.keys()], MAPS.map(m => m.id));
    assert.ok([...counts.values()].every(count => count === 200));
});

test('only the host can change a map; changing it clears readiness, countdown, input and old history', () => {
    const room = new Room('HOST', 'sandyard'); room.botCount = 0;
    const a = room.add('Host', 'hunter', 'blue'), b = room.add('Guest', 'vince', 'red');
    a.state.ready = b.state.ready = true; room.updateLobby(100);
    assert.equal(room.round.phase, 'countdown');
    assert.equal(room.configureMap(b.state.id, 'orbital', 200), false);
    for (const invalid of ['missing', '', null, {}, 3]) assert.equal(room.configureMap(a.state.id, invalid, 200), false);
    const life = a.state.life;
    room.history.record(100, [a.state, b.state]);
    room.enqueue(a, [{ ...neutralInput(1), life }], 200);
    assert.equal(room.configureMap(a.state.id, 'orbital', 200), true);
    assert.equal(room.round.phase, 'lobby'); assert.equal(room.round.nextAt, 0);
    assert.ok(!a.state.ready && !b.state.ready);
    assert.equal(a.queue.length, 0); assert.equal(room.history.frames.length, 0);
    assert.ok(a.state.life > life);
    assert.equal(room.map.id, 'orbital');
    room.start(300);
    assert.equal(room.configureMap(a.state.id, 'abyss', 400), false);
    assert.equal(room.map.id, 'orbital');
    room.round.phase = 'results';
    assert.equal(room.configureMap(a.state.id, 'abyss', 400), false);
});

test('random draws once per round before ready-up; every client receives the same resolved map', () => {
    let draws = 0;
    const room = new Room('RANDOM', 'random', () => ((draws++ % 5) + .5) / 5); room.botCount = 0;
    const a = room.add('Host', 'hunter', 'blue');
    for (let round = 0; round < 5; round++) {
        assert.equal(room.round.mapChoice, 'random'); assert.equal(room.map.id, MAPS[round].id);
        for (const self of [a.state.id, 'another-client']) {
            const snapshot = decodeServerMessage(encodeServerMessage({ type: 'snapshot', n: 1, base: 0, time: 1, full: true, players: [a.state], removed: [], round: room.round }, self));
            assert.equal(snapshot.type, 'snapshot');
            if (snapshot.type === 'snapshot') assert.equal(snapshot.round?.mapId, MAPS[round].id);
        }
        const now = 10000 * (round + 1);
        room.countdown(now, true); room.updateLobby(room.round.nextAt);
        assert.equal(draws, round + 1, 'ready and start never reroll the map shown in the lobby');
        room.tick(room.round.endsAt);
        assert.equal(room.round.phase, 'results');
        room.tick(room.round.nextAt);
        assert.equal(room.round.phase, 'lobby');
        assert.equal(draws, round + 2);
    }
});

test('a fixed map persists across rematches and simultaneous rooms do not share collision state', () => {
    const rooms = MAPS.map(map => new Room(map.id, map.id, () => { throw new Error('fixed map must not draw'); }));
    setClientMap('catacomb');
    try {
        for (const room of rooms) {
            room.botCount = 0; room.add('Host', 'triggerman', 'blue');
            for (let round = 0; round < 3; round++) {
                room.start(round * 1000000); room.tick(room.round.endsAt); room.tick(room.round.nextAt);
                assert.equal(room.map.id, room.id); assert.equal(room.map, getMap(room.id as typeof room.map.id));
            }
        }
    } finally { setClientMap('sandyard'); }
});

for (const map of MAPS) test(`${map.name}: server movement, client prediction and replay agree for recorded controls`, () => {
    const room = new Room('PARITY', map.id); room.botCount = 0;
    const actor = room.add('Runner', 'runngun', 'blue'); room.start(0);
    setClientMap(map.id);
    try {
        const initial = { ...actor.state }, predicted = { ...initial }, tape = [];
        for (let tick = 1; tick <= 360; tick++) {
            const input = wireInput({ ...neutralInput(tick), life: actor.state.life, slot: 3, forward: 1,
                yaw: initial.yaw + Math.floor(tick / 60) * .63, jump: tick % 17 === 0, slide: tick % 17 < 5 });
            tape.push(input); predictInput(predicted, input, true);
            assert.ok(room.enqueue(actor, [input], tick * STEP * 1000)); room.tick(tick * STEP * 1000);
            for (const key of ['x', 'y', 'z', 'vx', 'vy', 'vz', 'grounded', 'slide'] as const) assert.equal(predicted[key], actor.state[key], `${map.id} ${tick} ${key}`);
        }
        const replay = reconcile(initial, tape, true).predicted;
        for (const key of ['x', 'y', 'z', 'vx', 'vy', 'vz'] as const) assert.equal(replay[key], actor.state[key]);
    } finally { setClientMap('sandyard'); }
});

test('interleaved rooms retain their own physics, bot perception, navigation and prediction replay', t => {
    t.mock.method(Math, 'random', () => .5);
    const rooms = MAPS.map(map => {
        const room = new Room(map.id, map.id); room.botCount = 0;
        const actor = room.add('Runner', 'runngun', 'blue');
        const bot = room.add('Bot', 'hunter', 'red', true);
        room.start(0);
        const predicted = { ...actor.state }, history = new PredictionHistory();
        const botState = { ...bot.state }, botBrain = structuredClone(bot.botBrain!);
        // Exercise navigation and perception without deaths interrupting the tape.
        actor.state.hp = predicted.hp = bot.state.hp = botState.hp = 100000;
        return { room, actor, bot, predicted, history, botState, botBrain };
    });
    try {
        for (let tick = 1; tick <= 360; tick++) for (const [index, fixture] of rooms.entries()) {
            const { room, actor, bot, predicted, history, botState, botBrain } = fixture;
            // Deliberately poison the browser fallback with a different room's map.
            setClientMap(MAPS[(index + tick) % MAPS.length].id);
            const before = { ...actor.state }, now = tick * STEP * 1000;
            const input = wireInput({ ...neutralInput(tick), life: actor.state.life, forward: 1,
                yaw: Math.floor(tick / 90) * Math.PI / 2, slot: 3, jump: tick % 23 === 0 });
            history.add(input); predictInput(predicted, input, true, room.map);
            const replay = history.reconcile(before, true, undefined, room.map);
            const command = botInput(botState, botBrain, [predicted, botState], room.round.mode, room.difficulty, now, room.map);
            predictInput(botState, command, true, room.map);
            room.enqueue(actor, [input], now); room.tick(now);
            botState.ack = bot.state.ack;
            for (const field of Object.keys(moveState()) as (keyof ReturnType<typeof moveState>)[]) {
                assert.equal(predicted[field], actor.state[field], `${room.id} prediction ${tick} ${field}`);
                assert.equal(replay[field], actor.state[field], `${room.id} replay ${tick} ${field}`);
                assert.equal(botState[field], bot.state[field], `${room.id} bot ${tick} ${field}`);
            }
            assert.deepEqual(bot.botBrain!.path, botBrain.path, `${room.id}: bot routes use room geometry`);
            assert.equal(bot.botBrain!.target, botBrain.target, `${room.id}: bot visibility uses room geometry`);
            assert.ok(room.history.frames.every(f => f.players.size === 2), 'history only contains this room');
        }
    } finally { setClientMap('sandyard'); }
});

for (const map of MAPS) {
    test(`${map.name}: all classes spawn with 100 health and each ramp connects bots to its raised destination`, () => {
        const room = new Room('SPAWNS', map.id);
        for (const classId of CLASS_IDS) {
            const actor = room.add(classId, classId, 'blue');
            assert.equal(actor.state.hp, 100); assert.equal(actor.state.maxHp, 100);
            assert.ok(map.spawns.some(p => p.x === actor.state.x && p.y === actor.state.y && p.z === actor.state.z));
        }
        for (const r of map.ramps) {
            const span = r.axis === 'x' ? r.w : r.d;
            const low = { x: r.x, y: 0, z: r.z, [r.axis]: r[r.axis] - r.sign * (span / 2 + 2) };
            const high = { x: r.x, y: r.h, z: r.z, [r.axis]: r[r.axis] + r.sign * (span / 2 + 2) };
            const path = findPath(low, high, map);
            assert.ok(path.length > 0);
            assert.equal(path.at(-1)!.y, r.h);
            assert.ok(path.some(p => p.y > 0 && p.y < r.h), 'route uses the incline');
        }
    });

    test(`${map.name}: results suppress firing until map preparation starts a new, fully supplied life`, () => {
        const room = new Room('RESULTS', map.id); room.botCount = 0;
        const actor = room.add('Runner', 'triggerman', 'blue'); room.start(0);
        actor.state.ammo = actor.ammo.rifle = 1;
        room.tick(room.round.endsAt);
        const life = actor.state.life, deadline = room.round.nextAt;
        room.enqueue(actor, [{ ...neutralInput(1), life, combat: true, fire: true, shotTime: deadline - 1 }], deadline - 1);
        room.tick(deadline - 1);
        assert.equal(room.round.phase, 'results'); assert.equal(actor.state.life, life);
        assert.equal(actor.state.ammo, 1); assert.equal(actor.state.reloadEnd, 0);
        room.enqueue(actor, [{ ...neutralInput(2), life, combat: true, fire: true, shotTime: deadline }], deadline);
        room.tick(deadline);
        assert.equal(room.round.phase, 'lobby'); assert.equal(actor.state.life, life + 1);
        assert.equal(actor.state.ammo, 30); assert.equal(actor.state.reloadEnd, 0);
        assert.equal(room.events.filter(e => e.type === 'shot').length, 0);
    });
}
