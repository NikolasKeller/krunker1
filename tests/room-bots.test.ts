import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { Network } from '../src/client/network';
import { createGameServer } from '../src/server/index';
import { Room } from '../src/server/simulation';
import { botInput, brain } from '../src/server/bots';
import { moveState } from '../src/shared/movement';
import type { Difficulty } from '../src/shared/types';

async function until(fn: () => unknown, label: string) {
    const deadline = Date.now() + 4000;
    while (!fn()) { assert.ok(Date.now() < deadline, label); await delay(10); }
}

test('host bot settings replicate through invites, countdown, matches and rematches', async t => {
    const app = createGameServer();
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address(); assert.ok(address && typeof address === 'object');
    for (const [key, value] of Object.entries({ WebSocket, location: { protocol: 'http:', host: `127.0.0.1:${address.port}` }, sessionStorage: { getItem: () => null, setItem() {} } })) {
        const original = Object.getOwnPropertyDescriptor(globalThis, key);
        Object.defineProperty(globalThis, key, { configurable: true, value });
        t.after(() => { if (original) Object.defineProperty(globalThis, key, original); else Reflect.deleteProperty(globalThis, key); });
    }
    const host = new Network(), friend = new Network();
    try {
        host.connect({ name: 'Host', room: '', create: true, classId: 'hunter', team: 'blue' });
        await until(() => host.local, 'host admission');
        host.send({ type: 'configure', bots: 0, difficulty: 'hard' });
        await until(() => host.bots === 0 && host.difficulty === 'hard', 'zero selected');
        const invite = new URL(`http://127.0.0.1:${address.port}/?room=${host.room}`);
        friend.connect({ name: 'Friend', room: invite.searchParams.get('room')!, classId: 'hunter', team: 'red' });
        await until(() => friend.local && host.players.has(friend.id), 'friend joins by invite');
        const room = app.rooms.get(host.room)!;
        function verify(bots: number, level: Difficulty) {
            assert.equal(room.botCount, bots); assert.equal(room.difficulty, level);
            assert.equal([...room.players.values()].filter(a => a.state.bot).length, bots);
            for (const client of [host, friend]) {
                assert.equal(client.bots, bots); assert.equal(client.difficulty, level);
                assert.equal([...client.players.values()].filter(p => p.bot).length, bots);
            }
        }
        verify(0, 'hard');
        friend.send({ type: 'configure', bots: 7, difficulty: 'easy' });
        friend.send({ type: 'sync' });
        const oldSnapshot = friend.lastSnapshot;
        await until(() => friend.lastSnapshot > oldSnapshot, 'non-host request processed');
        verify(0, 'hard');
        for (const [bots, level] of [[0, 'hard'], [2, 'easy'], [2, 'normal'], [2, 'hard']] as const) {
            host.send({ type: 'configure', bots, difficulty: level });
            await until(() => [host, friend].every(c => c.bots === bots && c.difficulty === level), 'shared settings');
            for (let match = 0; match < 2; match++) {
                host.send({ type: 'ready', ready: true }); friend.send({ type: 'ready', ready: true });
                await until(() => [host, friend].every(c => c.round?.phase === 'countdown'), 'shared countdown');
                verify(bots, level);
                room.updateLobby(room.round.nextAt);
                await until(() => [host, friend].every(c => c.round?.phase === 'playing'), 'shared match');
                verify(bots, level);
                // Finish through the normal results/lobby lifecycle without a real minute-long wait.
                room.round.endsAt = Date.now() - 1; room.tick(Date.now());
                await until(() => [host, friend].every(c => c.round?.phase === 'results'), 'shared results');
                room.round.nextAt = Date.now() - 1; room.tick(Date.now());
                await until(() => [host, friend].every(c => c.round?.phase === 'lobby'), 'shared rematch lobby');
                verify(bots, level);
            }
        }
    } finally { host.disconnect(); friend.disconnect(); await app.close(); }
});

test('difficulty changes actual bot reaction time, aim error and navigation speed', t => {
    t.mock.method(Math, 'random', () => .75);
    const room = new Room('BRAIN');
    const bot = room.add('Bot', 'hunter', 'blue', true).state;
    const enemy = room.add('Enemy', 'hunter', 'red').state;
    Object.assign(bot, moveState(34, 0, 24), { yaw: 0, hp: 60 });
    Object.assign(enemy, moveState(34, 0, 0));
    const results = (['easy', 'normal', 'hard'] as const).map(level => {
        const b = brain();
        botInput(bot, b, [bot, enemy], 'tdm', level, 1000);
        assert.equal(b.target, enemy.id, 'the same unobstructed target is visible');
        const early = botInput(bot, b, [bot, enemy], 'tdm', level, 1250);
        const later = botInput(bot, b, [bot, enemy], 'tdm', level, 1450);
        const roam = { ...brain(), nextThink: Infinity, path: [{ x: 34, y: 0, z: 0 }] };
        const movement = botInput(bot, roam, [], 'tdm', level, 1000);
        return { early: early.fire, later: later.fire, error: Math.abs(b.yawError), speed: Math.hypot(movement.forward, movement.strafe) };
    });
    assert.deepEqual(results.map(r => r.early), [false, false, true]);
    assert.deepEqual(results.map(r => r.later), [false, true, true]);
    assert.ok(results[0].error > results[1].error && results[1].error > results[2].error);
    assert.ok(results[0].speed < results[1].speed && results[1].speed < results[2].speed);
});
