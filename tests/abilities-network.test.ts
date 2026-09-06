import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { createGameServer } from '../src/server/index';
import { Network } from '../src/client/network';
import { encodeClientMessage, encodeServerMessage, decodeServerMessage } from '../src/shared/protocol';
import { neutralInput, moveState } from '../src/shared/movement';
import type { GameEvent } from '../src/shared/types';
import { Room } from './sandyard-room';
import { RemoteHealth } from '../src/client/remote-health';

async function until(fn: () => unknown, label: string) {
    const end = Date.now() + 5000;
    while (!fn()) { assert.ok(Date.now() < end, label); await delay(10); }
}
test('real WebSocket client receives cooldowns, rejects raw early requests, and receives authoritative grenade damage', async t => {
    const app = createGameServer(); await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const addr = app.server.address(); assert.ok(addr && typeof addr === 'object');
    for (const [key, value] of Object.entries({ WebSocket, location: new URL(`http://127.0.0.1:${addr.port}`), sessionStorage: { getItem: () => null, setItem() {} } })) {
        const before = Object.getOwnPropertyDescriptor(globalThis, key); Object.defineProperty(globalThis, key, { configurable: true, value });
        t.after(() => before ? Object.defineProperty(globalThis, key, before) : Reflect.deleteProperty(globalThis, key));
    }
    const a = new Network(), b = new Network(); const events: GameEvent[] = []; a.onEvents = e => events.push(...e);
    try {
        a.connect({ name: 'Tools', room: '', create: true, classId: 'runngun', team: 'blue' }); await until(() => a.local, 'join');
        a.send({ type: 'configure', bots: 0, map: 'sandyard' }); await until(() => a.players.size === 1, 'remove bots');
        b.connect({ name: 'Target', room: a.room, classId: 'hunter', team: 'red' }); await until(() => b.local, 'target joins');
        const r = app.rooms.get(a.room)!, actor = r.players.get(a.id)!, target = r.players.get(b.id)!;
        r.start(Date.now()); await until(() => a.round?.phase === 'playing' && a.local?.life === actor.state.life, 'playing');
        Object.assign(actor.state, moveState(34, 0, 20)); Object.assign(target.state, moveState(34, 0, 10));
        a.input({ ...neutralInput(++a.seq), ability: true, grenade: true, shotTime: a.serverNow, interpolationDelay: 0 }); a.flush();
        await until(() => (a.local?.abilityReadyAt ?? 0) > a.serverNow, 'cooldown snapshot reaches client');
        const abilityReady = actor.state.abilityReadyAt, grenadeReady = actor.state.grenadeReadyAt;
        assert.ok((a.predicted?.abilitySteps ?? 0) > 0); assert.ok(events.some(e => e.type === 'grenade' && e.phase === 'flight'));
        // Bypass the client gate entirely: the server still refuses the request.
        a.ws!.send(encodeClientMessage({ type: 'input', inputs: [{ ...neutralInput(++a.seq), life: actor.state.life, shotTime: a.serverNow, interpolationDelay: 0, ability: true, grenade: true }] }));
        await until(() => actor.state.ack >= a.seq, 'hostile input processed');
        assert.equal(actor.state.abilityReadyAt, abilityReady); assert.equal(actor.state.grenadeReadyAt, grenadeReady); assert.equal(r.tactics.grenades.size, 1);
        const g = [...r.tactics.grenades.values()][0]; g.position = { x: 34, y: 1, z: 10 }; g.velocity = { x: 0, y: 0, z: 0 }; g.until = Date.now(); g.simulatedAt = g.until;
        await until(() => b.local?.hp === 35 && b.predicted?.hp === 35, 'grenade health and prediction reconcile');
        assert.ok(events.some(e => e.type === 'hit' && e.victim === b.id && e.damage === 65));
        // Reconnecting the same session never refreshes the cooldown budget.
        const id = a.id;
        a.connect({ name: 'Tools', room: r.id, classId: 'runngun', team: 'blue' });
        await until(() => a.local && a.status === 'CONNECTED', 'reconnect'); assert.equal(a.id, id);
        assert.equal(a.local!.abilityReadyAt, abilityReady); assert.equal(a.local!.grenadeReadyAt, grenadeReady);
        a.send({ type: 'class', classId: 'vince' });
        assert.equal(a.predicted!.abilityUntil, 0, 'selection immediately cancels the old visual power');
        assert.equal(a.predicted!.abilitySteps, 0); assert.equal(a.predicted!.abilityReadyAt, abilityReady);
        await until(() => a.local?.classId === 'vince', 'class switch confirmed');
        assert.equal(a.local!.abilityReadyAt, abilityReady); assert.equal(a.local!.grenadeReadyAt, grenadeReady);
    } finally { a.disconnect(); b.disconnect(); await app.close(); }
});

test('legacy binary snapshots keep their original field masks while v5 receives tactical state', () => {
    const p = new Room('LEGACY').add('P', 'vince', 'blue').state; p.abilityUntil = 100000; p.grenadeReadyAt = 120000;
    const message = { type: 'snapshot' as const, n: 1, base: 0, time: 50000, full: true, players: [p], removed: [] };
    const old = decodeServerMessage(encodeServerMessage(message, p.id, false)), modern = decodeServerMessage(encodeServerMessage(message, p.id));
    assert.ok(old.type === 'snapshot' && modern.type === 'snapshot'); assert.equal(old.players[0].abilityUntil, undefined); assert.equal(modern.players[0].abilityUntil, 100000);
});

test('grenade/healing feedback updates remote health immediately while retaining unconfirmed gun damage', () => {
    const r = new Room('HEALTH'), p = r.add('P', 'triggerman', 'blue').state, q = r.add('Q', 'vince', 'red').state;
    const players = new Map([[p.id, p], [q.id, q]]), health = new RemoteHealth(), sample = health.sample({ ...q }, 0);
    health.predict({ type: 'hit', key: `${p.life}:5:${q.id}`, shooter: p.id, victim: q.id, damage: 42, zone: 'body', point: q, from: p, lethal: false }, players, 0);
    assert.equal(sample.hp, 58);
    q.hp = 90; health.tactical({ type: 'tactical', time: 1000, events: [], players: [{ id: q.id, life: q.life, hp: 90 }] }, players, p.id, 1);
    assert.equal(sample.hp, 48);
    q.hp = 95; health.tactical({ type: 'tactical', time: 1100, events: [], players: [{ id: q.id, life: q.life, hp: 95 }] }, players, p.id, 2);
    assert.equal(sample.hp, 53);
    q.hp = 53; health.resolve({ type: 'combat', time: 1200, shooter: p.id, life: p.life, seq: 5, accepted: true, events: [], players: [{ id: q.id, life: q.life, hp: 53 }] }, players, p.id, 3);
    assert.equal(health.sample({ ...q }, 500).hp, 53);
});
