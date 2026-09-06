import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { createGameServer } from '../src/server/index';
import type { ClientMessage, PlayerState, RoundState, ServerMessage } from '../src/shared/types';
const app = createGameServer();
await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
const address = app.server.address();
assert.ok(address && typeof address !== 'string');
const origin = `http://127.0.0.1:${address.port}`;
const wait = async (fn: () => unknown, label: string, timeout = 5000) => {
    const start = Date.now();
    while (!fn()) { if (Date.now() - start > timeout) throw new Error(label); await delay(15); }
};
class Client {
    ws = new WebSocket(origin.replace('http', 'ws') + '/ws');
    id = ''; room = ''; token = ''; host = ''; error = '';
    players = new Map<string, PlayerState>();
    round?: RoundState;
    constructor(room = '', name = 'Friend', token?: string) {
        this.ws.on('open', () => this.send({ type: 'join', room, name, classId: 'triggerman', team: 'blue', token }));
        this.ws.on('message', data => {
            const m = JSON.parse(data.toString()) as ServerMessage;
            if (m.type === 'welcome') { this.id = m.id; this.room = m.room; this.token = m.token; }
            if (m.type === 'error') this.error = m.message;
            if (m.type === 'snapshot') {
                if (m.full) this.players.clear();
                for (const p of m.players) this.players.set(p.id, { ...this.players.get(p.id), ...p } as PlayerState);
                for (const id of m.removed) this.players.delete(id);
                if (m.round) this.round = m.round; if (m.host !== undefined) this.host = m.host;
            }
        });
    }
    send(m: ClientMessage) { this.ws.send(JSON.stringify(m)); }
    get p() { return this.players.get(this.id); }
    close() { this.ws.close(); }
}
const clients: Client[] = [];
const join = async (room = '', name = 'Friend', token?: string) => {
    const c = new Client(room, name, token); clients.push(c);
    await wait(() => c.p || c.error, 'join response'); return c;
};
try {
    const a = await join();
    assert.match(a.room, /^[A-HJ-NP-Z2-9]{5}$/);
    const b = await join(a.room);
    assert.equal(b.p!.name, 'Friend (2)');
    await wait(() => a.players.has(b.id), 'live roster join');
    assert.equal(a.host, a.id);
    b.send({ type: 'configure', mode: 'tdm', scoreLimit: 10 });
    b.send({ type: 'start' });
    await delay(100);
    assert.equal(a.round!.mode, 'ffa'); assert.equal(a.round!.phase, 'lobby');
    a.send({ type: 'configure', bots: 0, mode: 'tdm', scoreLimit: 10, duration: 60000 });
    b.send({ type: 'class', classId: 'hunter', team: 'red' });
    b.send({ type: 'profile', name: '<Friend>' });
    await wait(() => a.players.get(b.id)?.team === 'red' && a.round?.scoreLimit === 10, 'host settings and team replicate');
    assert.equal(a.round!.duration, 60000);
    assert.equal(b.p!.name, 'Friend (2)');
    a.send({ type: 'ready', ready: true });
    await wait(() => b.players.get(a.id)?.ready, 'own readiness reflected remotely');
    assert.equal(a.round!.phase, 'lobby');
    b.send({ type: 'ready', ready: true });
    await wait(() => a.round?.phase === 'countdown' && b.round?.phase === 'countdown', 'all-ready countdown');
    assert.equal(a.round!.nextAt, b.round!.nextAt);
    b.send({ type: 'ready', ready: false });
    await wait(() => a.round?.phase === 'lobby', 'unready cancels countdown');
    b.send({ type: 'ready', ready: true });
    await wait(() => a.round?.phase === 'countdown', 'restart countdown');
    const c = await join(a.room, 'Charlie');
    await wait(() => a.round?.phase === 'lobby', 'unready new arrival cancels countdown');
    c.close();
    await wait(() => !a.players.has(c.id) && a.round?.phase === 'countdown', 'unready disconnect no longer blocks');
    await wait(() => a.round?.phase === 'playing' && b.round?.phase === 'playing', 'simultaneous match start');
    assert.equal(a.round!.endsAt, b.round!.endsAt);
    const late = await join(a.room, 'Late');
    assert.equal(late.round!.phase, 'playing'); assert.equal(late.p!.alive, true);
    assert.equal(late.p!.protectionEnd, 0);
    const lateId = late.id, token = late.token;
    late.close();
    await wait(() => !a.players.has(lateId), 'disconnect removed immediately');
    const other = await join(a.room, 'Other');
    const resumed = await join(a.room, 'Late', token);
    assert.equal(resumed.id, lateId, 'joining someone else must not invalidate reconnect grace');
    a.close();
    await wait(() => b.host === b.id, 'host migration');
    const room = app.rooms.get(b.room)!;
    room.round.endsAt = Date.now();
    await wait(() => b.round?.phase === 'results', 'match results');
    assert.ok(b.round!.results?.some(p => p.id === a.id));
    assert.ok([...room.players.values()].every(p => !p.state.ready));
    room.round.nextAt = Date.now();
    await wait(() => b.round?.phase === 'lobby', 'same lobby after results');
    assert.ok(b.round!.results!.length >= 4, 'results survive in lobby');
    await delay(250); assert.equal(b.round!.phase, 'lobby', 'no automatic restart');
    b.send({ type: 'start' });
    await wait(() => b.round?.phase === 'countdown', 'new host force-starts unready players');
    await wait(() => b.round?.phase === 'playing', 'forced countdown starts');
    assert.equal(b.round!.round, 2);
    assert.ok([...room.players.values()].every(a => a.state.kills === 0));
    // Fill ten human slots while retaining all seven bots, then exercise replacement admission.
    for (const c of [other, resumed]) c.close();
    await delay(100);
    room.round.endsAt = Date.now(); await wait(() => b.round?.phase === 'results', 'round finish');
    room.round.nextAt = Date.now(); await wait(() => b.round?.phase === 'lobby', 'lobby');
    b.send({ type: 'configure', bots: 7 });
    const full: Client[] = [b];
    for (let i = 1; i < 10; i++) full.push(await join(b.room, 'Friend'));
    await wait(() => b.players.size === 17, 'ten humans plus seven bots');
    assert.equal(new Set([...b.players.values()].map(p => p.name.toLowerCase())).size, 17);
    const rejected = await join(b.room, 'Eleventh'); assert.match(rejected.error, /full/);
    const departing = full.pop()!; departing.close();
    await wait(() => !b.players.has(departing.id), 'free slot on disconnect');
    const replacement = await join(b.room, 'Replacement'); assert.ok(replacement.id);
    const connection = await (await fetch(origin + '/api/connection')).json();
    assert.ok(Array.isArray(connection.lan));
    console.log('PASS: invite codes, duplicate names, live team/ready roster, host-only settings, synchronized countdown/cancellation, late join, reconnect, host handover, results/lobby/rematch, 10 humans + 7 bots, full-room replacement, LAN discovery');
} finally {
    for (const c of clients) c.ws.terminate();
    await app.close();
}
