import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { Network } from '../src/client/network';
import { createGameServer } from '../src/server/index';
import { moveState, neutralInput } from '../src/shared/movement';
import type { Actor } from '../src/server/simulation';
import { CLASS_IDS, CLASSES, WEAPONS } from '../src/shared/weapons';

async function until(fn: () => unknown, label: string) {
    const end = Date.now() + 5000;
    while (!fn()) { assert.ok(Date.now() < end, label); await delay(10); }
}

test('join → ready → play → damage → death → respawn → class → team → rematch → reconnect → takeover → late join stays damageable', async t => {
    const app = createGameServer();
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address(); assert.ok(address && typeof address === 'object');
    const values = { WebSocket, location: new URL(`http://127.0.0.1:${address.port}`), sessionStorage: { getItem: () => null, setItem() {} } };
    for (const [key, value] of Object.entries(values)) {
        const before = Object.getOwnPropertyDescriptor(globalThis, key);
        Object.defineProperty(globalThis, key, { configurable: true, value });
        t.after(() => before ? Object.defineProperty(globalThis, key, before) : Reflect.deleteProperty(globalThis, key));
    }
    const shooter = new Network(), target = new Network(), late = new Network();
    let takeover: WebSocket | undefined;
    try {
        shooter.connect({ name: 'Shooter', room: '', create: true, classId: 'triggerman', team: 'blue' });
        await until(() => shooter.local, 'shooter joins');
        shooter.send({ type: 'configure', bots: 0 });
        await until(() => shooter.players.size === 1, 'bots removed');
        const config = { name: 'Target', room: shooter.room, classId: 'hunter' as const, team: 'red' as const };
        target.connect(config); await until(() => target.local, 'target joins');
        const room = app.rooms.get(shooter.room)!, a = room.players.get(shooter.id)!, b = room.players.get(target.id)!;
        let seq = 0;
        async function damage(label: string, victim: Actor = b, client: Network = target) {
            assert.equal(room.players.get(victim.state.id), victim, label + ': active actor identity');
            assert.ok(victim.connected && victim.state.alive, label + ': target available');
            assert.equal(victim.state.maxHp, 100); assert.equal(victim.state.protectionEnd, 0);
            Object.assign(a.state, moveState(34, 0, 20), { yaw: 0, pitch: -.05, bloom: 0 });
            Object.assign(victim.state, moveState(34, 0, 10));
            const hp = victim.state.hp;
            // Keep production lifecycle/history intact; update only the test's
            // aiming lane. fire is the real damage path (also tested in lobby).
            const shotTime = Math.max(Date.now(), (room.history.frames.at(-1)?.time ?? 0) + 1);
            room.history.record(shotTime, [a.state, victim.state]);
            room.fire(a, { ...neutralInput(++seq), shotTime, interpolationDelay: 0 }, shotTime);
            assert.ok(victim.state.hp < hp, `${label}: ${hp} -> ${victim.state.hp}`);
            await until(() => client.local?.hp === victim.state.hp && client.predicted?.hp === victim.state.hp, label + ': downward health reconciliation');
        }
        await damage('join');
        target.send({ type: 'ready', ready: true }); await until(() => b.state.ready, 'ready applied');
        await damage('ready');
        shooter.send({ type: 'ready', ready: true }); await until(() => room.round.phase === 'countdown', 'countdown');
        room.round.nextAt = Date.now(); await until(() => target.round?.phase === 'playing', 'round starts');
        await damage('play'); await damage('take damage'); await damage('die');
        assert.equal(b.state.hp, 0); assert.equal(b.state.alive, false);
        const respawnAt = b.state.respawnAt;
        target.send({ type: 'class', classId: 'vince' });
        await until(() => b.state.classId === 'vince', 'dead class applies');
        assert.equal(b.state.alive, false); assert.equal(b.state.respawnAt, respawnAt);
        b.state.respawnAt = Date.now(); await until(() => target.local?.alive, 'respawn');
        assert.equal(b.state.hp, 100); await damage('respawn');
        target.send({ type: 'class', classId: 'runngun' });
        await until(() => target.local?.weapon === 'smg', 'live loadout'); await damage('class');
        target.send({ type: 'team', team: 'blue' });
        await until(() => target.local?.team === 'blue', 'live team'); await damage('team');
        room.round.endsAt = Date.now(); await until(() => room.round.phase === 'results', 'results');
        room.round.nextAt = Date.now(); await until(() => target.round?.phase === 'lobby', 'rematch lobby');
        target.send({ type: 'class', classId: 'hunter' }); await until(() => target.local?.classId === 'hunter', 'no stale pending class survives results');
        target.send({ type: 'ready', ready: true }); shooter.send({ type: 'ready', ready: true });
        await until(() => room.round.phase === 'countdown', 'rematch ready'); room.round.nextAt = Date.now();
        await until(() => target.round?.phase === 'playing', 'rematch plays'); await damage('rematch');
        const id = target.id, hp = b.state.hp, life = b.state.life;
        target.connect(config); await until(() => target.local && target.status === 'CONNECTED', 'reconnect');
        assert.equal(target.id, id); assert.equal(b.state.hp, hp); assert.equal(b.state.life, life);
        await damage('reconnect');
        const token = (target as unknown as { tokens: Map<string, string> }).tokens.get(room.id)!;
        takeover = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
        await new Promise<void>(resolve => takeover!.once('open', resolve));
        takeover.send(JSON.stringify({ type: 'join', ...config, token }));
        await until(() => target.status === 'SESSION MOVED', 'active token takeover');
        assert.equal(room.players.get(id), b); assert.equal(b.state.hp, 16, 'takeover cannot heal');
        assert.equal(b.connected, true, 'old close cannot disconnect resumed actor');
        target.connect(config); await until(() => target.local && target.status === 'CONNECTED', 'reclaim token');
        await damage('session takeover');
        const deathDeadline = b.state.respawnAt;
        target.connect(config); await until(() => target.local && target.status === 'CONNECTED', 'dead reconnect');
        assert.equal(b.state.hp, 0); assert.equal(b.state.alive, false); assert.equal(b.state.respawnAt, deathDeadline);
        late.connect({ ...config, name: 'Late join', classId: 'vince' }); await until(() => late.round?.phase === 'playing', 'late join');
        await damage('late join', room.players.get(late.id)!, late);
        const lateId = late.id;
        late.connect({ ...config, room: '', create: true }); await until(() => late.local && late.room !== room.id, 'switch room');
        late.connect({ ...config, name: 'Late join' }); await until(() => late.local && late.room === room.id, 'rejoin running room');
        assert.equal(late.id, lateId); await damage('room rejoin', room.players.get(late.id)!, late);
        for (const classId of CLASS_IDS) {
            const actor = room.add(classId, classId, 'red');
            assert.equal(actor.state.hp, 100); assert.equal(actor.state.maxHp, 100);
            assert.equal(actor.state.weapon, CLASSES[classId].weapon);
            assert.equal(actor.state.ammo, WEAPONS[CLASSES[classId].weapon].magazine);
            room.remove(actor.state.id);
        }
    } finally { takeover?.terminate(); shooter.disconnect(); target.disconnect(); late.disconnect(); await app.close(); }
});

test('real WebSockets apply team/class requests in either order in lobby and live play', async t => {
    const app = createGameServer();
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address(); assert.ok(address && typeof address === 'object');
    for (const [key, value] of Object.entries({ WebSocket, location: new URL(`http://127.0.0.1:${address.port}`), sessionStorage: { getItem: () => null, setItem() {} } })) {
        const before = Object.getOwnPropertyDescriptor(globalThis, key);
        Object.defineProperty(globalThis, key, { configurable: true, value });
        t.after(() => before ? Object.defineProperty(globalThis, key, before) : Reflect.deleteProperty(globalThis, key));
    }
    const net = new Network(), observer = new Network();
    try {
        net.connect({ name: 'Self', room: '', create: true, classId: 'triggerman', team: 'blue' });
        await until(() => net.local, 'join');
        net.send({ type: 'configure', bots: 0, mode: 'tdm' }); await until(() => net.players.size === 1, 'configure');
        observer.connect({ name: 'Observer', room: net.room, classId: 'hunter', team: 'red' });
        await until(() => observer.local, 'observer');
        const room = app.rooms.get(net.room)!, a = room.players.get(net.id)!;
        for (const phase of ['lobby', 'playing'] as const) {
            if (phase === 'playing') { room.start(Date.now()); await until(() => net.round?.phase === 'playing', 'start'); }
            for (const order of ['team', 'class', 'team-class', 'class-team', 'class-class-team']) {
                let classId = a.state.classId, team = a.state.team;
                const hp = a.state.hp;
                for (const step of order.split('-')) {
                    if (step === 'team') { team = team === 'blue' ? 'red' : 'blue'; net.send({ type: 'team', team }); }
                    else { classId = classId === 'hunter' ? 'runngun' : 'hunter'; net.send({ type: 'class', classId }); }
                    assert.equal(net.predicted!.classId, classId); assert.equal(net.predicted!.team, team);
                    assert.equal(net.predicted!.weapon, CLASSES[classId].weapon);
                }
                await until(() => a.state.classId === classId && a.state.team === team && net.local?.classId === classId && net.local.team === team && !net.changingClass && observer.players.get(net.id)?.life === a.state.life, `${phase}/${order} applied`);
                const n = net.lastSnapshot;
                await until(() => net.lastSnapshot !== n, 'next periodic snapshot');
                assert.equal(net.predicted!.weapon, a.state.weapon); assert.equal(net.predicted!.ammo, a.state.ammo);
                assert.equal(net.predicted!.hp, hp); assert.equal(net.predicted!.classId, classId); assert.equal(net.predicted!.team, team);
                const remote = observer.remotePlayers().find(p => p.id === net.id)!;
                assert.equal(remote.team, team); assert.equal(remote.classId, classId); assert.equal(remote.weapon, a.state.weapon);
            }
        }
    } finally { net.disconnect(); observer.disconnect(); await app.close(); }
});
