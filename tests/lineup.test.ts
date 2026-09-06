import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { Network } from '../src/client/network';
import { createGameServer } from '../src/server/index';
import { Room } from '../src/server/simulation';
import { summarizeLineup } from '../src/shared/lobby';
import type { Team } from '../src/shared/types';

test('lineup counts include bots, while readiness counts only human votes', () => {
    const room = new Room('LINEUP');
    const host = room.add('Host', 'hunter', 'blue').state;
    const friend = room.add('Friend', 'vince', 'red').state;
    room.add('Bot', 'runngun', 'red', true);
    const summary = () => summarizeLineup([...room.players.values()].map(a => a.state));
    host.ready = true;
    assert.equal(summary().total, 3);
    assert.equal(summary().humans, 2);
    assert.equal(summary().bots, 1);
    assert.equal(summary().blue.length, 1);
    assert.equal(summary().red.length, 2);
    assert.equal(summary().ready, 1);
    assert.deepEqual(summary().waiting.map(p => p.id), [friend.id]);
    assert.equal(summary().allReady, false);
    friend.team = 'blue'; friend.ready = true;
    assert.equal(summary().blue.length, 2);
    assert.equal(summary().red.length, 1);
    assert.equal(summary().allReady, true);
    room.remove(friend.id);
    assert.equal(summary().total, 2);
    assert.equal(summary().blue.length, 1);
    assert.equal(summary().ready, 1);
    room.remove(host.id);
    assert.equal(summary().allReady, false, 'bots alone never start a match');
    assert.equal(summarizeLineup([]).allReady, false);
});

test('team assignment authorizes self or host, validates targets and cancels readiness only on a change', () => {
    const room = new Room('MOVES');
    const host = room.add('Host', 'hunter', 'blue'), friend = room.add('Friend', 'vince', 'red');
    host.state.ready = friend.state.ready = true;
    room.countdown(1000, true);
    assert.equal(room.moveTeam(friend.state.id, host.state.id, 'red', 1100), false);
    assert.equal(room.moveTeam(host.state.id, 'missing', 'red', 1100), false);
    assert.equal(room.moveTeam(host.state.id, friend.state.id, 'invalid' as Team, 1100), false);
    assert.equal(room.round.phase, 'countdown');
    assert.equal(room.moveTeam(friend.state.id, friend.state.id, 'red', 1100), true);
    assert.equal(friend.state.ready, true, 'selecting the current team leaves readiness intact');
    assert.equal(room.moveTeam(host.state.id, friend.state.id, 'blue', 1200), true);
    assert.equal(friend.state.team, 'blue');
    assert.equal(friend.state.classId, 'vince');
    assert.equal(friend.state.ready, false);
    assert.equal(host.state.ready, true);
    assert.equal(room.round.phase, 'lobby');
    assert.equal(room.forcedCountdown, false);
    friend.connected = false;
    assert.equal(room.moveTeam(host.state.id, friend.state.id, 'red', 1300), false);
    friend.connected = true;
    for (const phase of ['results'] as const) {
        room.round.phase = phase;
        assert.equal(room.moveTeam(host.state.id, friend.state.id, 'red', 1400), false);
        assert.equal(room.moveTeam(friend.state.id, friend.state.id, 'red', 1400), false);
    }
});

async function until(fn: () => unknown, label: string) {
    const deadline = Date.now() + 5000;
    while (!fn()) { assert.ok(Date.now() < deadline, label); await delay(10); }
}

test('three real clients share team moves, permissions, classes, bots, readiness and departures', async t => {
    const app = createGameServer();
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address(); assert.ok(address && typeof address === 'object');
    for (const [key, value] of Object.entries({ WebSocket, location: { protocol: 'http:', host: `127.0.0.1:${address.port}` }, sessionStorage: { getItem: () => null, setItem() {} } })) {
        const original = Object.getOwnPropertyDescriptor(globalThis, key);
        Object.defineProperty(globalThis, key, { configurable: true, value });
        t.after(() => { if (original) Object.defineProperty(globalThis, key, original); else Reflect.deleteProperty(globalThis, key); });
    }
    const host = new Network(), friend = new Network(), observer = new Network(), clients = [host, friend, observer];
    try {
        host.connect({ name: 'Host', room: '', create: true, classId: 'hunter', team: 'blue' });
        await until(() => host.local, 'host connected');
        host.send({ type: 'configure', bots: 2, mode: 'tdm' });
        await until(() => host.bots === 2 && host.players.size === 3, 'two bots configured');
        friend.connect({ name: 'Friend', room: host.room, classId: 'vince', team: 'red' });
        observer.connect({ name: 'Observer', room: host.room, classId: 'runngun', team: 'blue' });
        await until(() => clients.every(c => c.players.size === 5), 'all peers see the same five participants');
        const room = app.rooms.get(host.room)!;
        const shared = (id: string, team: Team) => clients.every(c => c.players.get(id)?.team === team);
        function verifyCounts(peers = clients) {
            const expected = summarizeLineup([...room.players.values()].filter(a => a.connected).map(a => a.state));
            for (const c of peers) {
                const actual = summarizeLineup(c.players.values());
                for (const key of ['total', 'humans', 'bots', 'ready', 'allReady'] as const) assert.equal(actual[key], expected[key], key);
                assert.equal(actual.blue.length, expected.blue.length);
                assert.equal(actual.red.length, expected.red.length);
                assert.equal(actual.blue.length + actual.red.length, actual.total);
            }
        }
        verifyCounts();
        friend.send({ type: 'ready', ready: true });
        await until(() => clients.every(c => c.players.get(friend.id)?.ready), 'ready state shared');
        friend.send({ type: 'team', team: 'blue' });
        await until(() => shared(friend.id, 'blue') && clients.every(c => !c.players.get(friend.id)?.ready), 'self switch updates all clients and clears readiness');
        verifyCounts();
        friend.send({ type: 'team', playerId: host.id, team: 'red' });
        // Ordered profile message proves the server processed the unauthorized request first.
        friend.send({ type: 'profile', name: 'Move rejected' });
        await until(() => clients.every(c => c.players.get(friend.id)?.name === 'Move rejected'), 'non-host request processed');
        assert.ok(shared(host.id, 'blue'));
        host.send({ type: 'team', playerId: friend.id, team: 'red' });
        await until(() => shared(friend.id, 'red'), 'host moves another player on every client');
        friend.send({ type: 'class', classId: 'triggerman' });
        await until(() => clients.every(c => c.players.get(friend.id)?.classId === 'triggerman'), 'class change shared');
        assert.ok(shared(friend.id, 'red'), 'class selection retains host assignment');
        const bot = [...host.players.values()].find(p => p.bot)!;
        const botTeam = bot.team === 'blue' ? 'red' : 'blue';
        host.send({ type: 'team', playerId: bot.id, team: botTeam });
        await until(() => shared(bot.id, botTeam), 'host moves bot on every client');
        verifyCounts();
        for (const c of clients) c.send({ type: 'ready', ready: true });
        await until(() => clients.every(c => c.round?.phase === 'countdown' && summarizeLineup(c.players.values()).ready === 3), 'all human votes start a shared countdown');
        verifyCounts();
        host.send({ type: 'team', playerId: friend.id, team: 'blue' });
        await until(() => clients.every(c => c.round?.phase === 'lobby' && !c.players.get(friend.id)?.ready), 'host move cancels countdown everywhere');
        verifyCounts();
        assert.deepEqual(summarizeLineup(host.players.values()).waiting.map(p => p.id), [friend.id]);
        observer.disconnect();
        await until(() => [host, friend].every(c => !c.players.has(observer.id)), 'departure removes card and vote');
        verifyCounts([host, friend]);
        host.disconnect();
        await until(() => friend.host === friend.id && !friend.players.has(host.id), 'host migration');
        friend.send({ type: 'team', playerId: bot.id, team: bot.team });
        await until(() => friend.players.get(bot.id)?.team === bot.team, 'new host can move a bot');
        verifyCounts([friend]);
    } finally { for (const c of clients) c.disconnect(); await app.close(); }
});
