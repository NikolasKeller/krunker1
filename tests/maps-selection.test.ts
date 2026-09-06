import assert from 'node:assert/strict';
import test from 'node:test';
import { MAPS, chooseMap, getMap, setClientMap } from '../src/shared/map';
import { Room } from '../src/server/simulation';
import { neutralInput } from '../src/shared/movement';
import { predictInput, reconcile } from '../src/client/prediction';
import { encodeServerMessage, decodeServerMessage, wireInput } from '../src/shared/protocol';
import { STEP } from '../src/shared/types';

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
