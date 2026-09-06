import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeClientMessage, decodeServerMessage, encodeClientMessage, encodeServerMessage, wireInput, MAX_INPUT_BATCH, MAX_CLIENT_PAYLOAD } from '../src/shared/protocol';
import { neutralInput, validInput, moveState } from '../src/shared/movement';
import { wirePlayer, playerDelta } from '../src/shared/snapshot';
import { reconcile, predictInput } from '../src/client/prediction';
import { Room } from './sandyard-room';
import type { GameEvent, Input, PlayerState, ServerMessage } from '../src/shared/types';

test('binary input preserves sequence/life, button edges and the exact prediction floats', () => {
    const inputs = Array.from({ length: MAX_INPUT_BATCH }, (_, n) => wireInput({ ...neutralInput(100 + n), life: 24, forward: .3, strafe: -.8, yaw: 3.271, pitch: Math.PI / 2, fire: n % 2 === 0, jump: n === 4, slide: n === 5, reload: n === 6, aim: true, slot: (n % 3 + 1) as Input['slot'], shotTime: 1780000000123 + n * 16.667 }));
    const encoded = encodeClientMessage({ type: 'input', inputs });
    assert.ok(encoded instanceof Uint8Array);
    assert.ok(encoded.length < MAX_CLIENT_PAYLOAD);
    const decoded = decodeClientMessage(encoded);
    assert.deepEqual(decoded, { type: 'input', inputs });
    assert.ok(inputs.every(validInput));
    for (let n = 0; n < encoded.length; n++) assert.throws(() => decodeClientMessage(encoded.slice(0, n)), 'truncated frames rejected');
    assert.throws(() => decodeClientMessage(new Uint8Array([...encoded, 0])));
    const invalid = decodeClientMessage(encodeClientMessage({ type: 'input', inputs: [{ ...neutralInput(1), pitch: 10 }] }));
    assert.ok(invalid.type === 'input'); assert.equal(validInput(invalid.inputs[0]), false, 'codec does not sanitize invalid client movement');
});

test('binary full/delta snapshots reconstruct every player field and preserve long-running acknowledgements', () => {
    const room = new Room('WIRE'), a = room.add('名前 🌍', 'hunter', 'red').state;
    a.x = 32.72; a.z = -26.88; a.vx = .123456789;
    a.ack = 2 ** 24 + 1; a.life = 2 ** 24 + 3;
    const full: ServerMessage = { type: 'snapshot', n: 42, base: 0, time: Date.now(), full: true, players: [wirePlayer(a, true)], removed: [], round: room.round, host: a.id, bots: 0, difficulty: 'hard' };
    const decoded = decodeServerMessage(encodeServerMessage(full, a.id)); assert.ok(decoded.type === 'snapshot');
    assert.equal(decoded.players[0].ack, a.ack); assert.equal(decoded.players[0].life, a.life);
    assert.deepEqual(decoded.round, full.round); assert.equal(decoded.bots, 0);
    for (const key of Object.keys(a) as (keyof PlayerState)[]) {
        const got: unknown = decoded.players[0][key], expected: unknown = full.players[0][key];
        if (typeof expected === 'number') assert.equal(got, expected, key);
        else assert.equal(got, expected, key);
    }
    const next = { ...a, x: a.x + 1.125, ready: true, alive: false, hp: 0 };
    const patch = playerDelta(wirePlayer(next, true), wirePlayer(a, true))!;
    const delta = decodeServerMessage(encodeServerMessage({ ...full, n: 43, base: 42, full: false, players: [patch], removed: ['gone'], round: undefined }, a.id));
    assert.ok(delta.type === 'snapshot'); assert.deepEqual(delta.players[0], patch); assert.deepEqual(delta.removed, ['gone']);
    const pending = Array.from({ length: 20 }, (_, n) => wireInput({ ...neutralInput(a.ack + n + 1), life: a.life, forward: 1, yaw: .123 }));
    const reference = reconcile(full.players[0] as PlayerState, pending, true).predicted;
    const binary = reconcile(decoded.players[0] as PlayerState, pending, true).predicted;
    assert.deepEqual(binary, reference, 'local prediction round trip retains exact collision boundary decisions');
});

test('all gameplay events use compact binary frames and retain identity, scoring and hit data', () => {
    const events: GameEvent[] = [
        { type: 'shot', shooter: 'p1', weapon: 'shotgun', seq: 9, origin: { x: 1, y: 2, z: 3 }, ends: [{ x: 4, y: 5, z: 6 }, { x: 7, y: 8, z: 9 }] },
        { type: 'hit', shooter: 'p1', victim: 'p2', damage: 100, zone: 'head', point: { x: 1, y: 2, z: 3 }, from: { x: 4, y: 5, z: 6 }, lethal: true },
        { type: 'kill', killer: 'p1', victim: 'p2', killerName: '🎯', victimName: 'B', weapon: 'shotgun', headshot: true, team: 'red' },
        { type: 'notice', text: 'Welcome 🌍' }
    ];
    const encoded = encodeServerMessage({ type: 'events', events });
    assert.ok(encoded instanceof Uint8Array); assert.ok(encoded.length < JSON.stringify(events).length / 2);
    assert.deepEqual(decodeServerMessage(encoded), { type: 'events', events });
});


test('local snapshot precision preserves movement along a crate contact face', () => {
    const state = new Room('CONTACT').add('Contact', 'triggerman', 'blue').state;
    Object.assign(state, moveState(10.3, 0, 21.52));
    const message: ServerMessage = { type: 'snapshot', n: 1, base: 0, time: 0, full: true, players: [wirePlayer(state, true)], removed: [] };
    const exact = decodeServerMessage(encodeServerMessage(message, state.id));
    const rounded = decodeServerMessage(encodeServerMessage(message));
    assert.ok(exact.type === 'snapshot' && rounded.type === 'snapshot');
    const authority = { ...state }, local = exact.players[0] as PlayerState, remotePrecision = rounded.players[0] as PlayerState;
    const input = { ...neutralInput(1), strafe: 1 };
    for (const p of [authority, local, remotePrecision]) predictInput(p, input, true);
    assert.ok(Math.hypot(authority.x - remotePrecision.x, authority.z - remotePrecision.z) > 1, 'float32 contact rounding reproduces a metre-scale prediction error');
    assert.deepEqual(local, authority, 'the local wire state preserves the collision decision exactly');
});
