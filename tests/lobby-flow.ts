import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createGameServer } from '../src/server/index';
import type { PlayerState, RoundState } from '../src/shared/types';

// GAME_URL exercises an already-running production server. Without it, own a real server.
const app = process.env.GAME_URL ? undefined : createGameServer();
if (app) await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
const address = app?.server.address();
const origin = process.env.GAME_URL ?? `http://127.0.0.1:${address && typeof address !== 'string' ? address.port : 0}`;
interface State {
    id: string; room: string; host: string; status: string; round?: RoundState; players: PlayerState[];
    readySent: { type: 'ready'; ready: boolean }[]; startSent: number; label: string; statusText: string; stable: boolean;
    metrics: { polls: number; updates: number; writes: number };
}
const clients: Client[] = [];
class Client {
    state?: State;
    error = '';
    child = fork(new URL('./lobby-client.ts', import.meta.url), { execArgv: ['--import', 'tsx'], env: { ...process.env, GAME_URL: origin }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    constructor() {
        clients.push(this);
        this.child.on('message', state => { this.state = state as State; });
        this.child.on('error', error => { this.error = error.message; });
        this.child.on('exit', code => { if (code) this.error = `client exited ${code}`; });
    }
    command(command: string, room?: string, name?: string) { this.child.send({ command, room, name }); }
    get humans() { return this.state?.players.filter(p => !p.bot) ?? []; }
    get ready() { return this.humans.filter(p => p.ready).length; }
    get local() { return this.humans.find(p => p.id === this.state?.id); }
}
async function wait(fn: () => unknown, label: string, timeout = 7000) {
    const until = Date.now() + timeout;
    while (!fn()) {
        for (const c of clients) assert.equal(c.error, '', c.error);
        assert.ok(Date.now() < until, `${label}: ${JSON.stringify(clients.map(c => c.state))}`);
        await delay(20);
    }
}
try {
    const a = new Client(), b = new Client();
    await wait(() => a.state && b.state, 'clients boot');
    a.command('create'); await wait(() => a.local && a.state?.label === 'READY UP', 'CREATE LOBBY click');
    const room = a.state!.room; assert.match(room, /^[A-HJ-NP-Z2-9]{5}$/);
    a.command('no-bots');
    b.command('join', room);
    await wait(() => a.humans.length === 2 && b.humans.length === 2 && b.state?.label === 'READY UP', 'second client joins');
    assert.equal(a.local!.name, 'Friend'); assert.equal(b.local!.name, 'Friend (2)');
    b.command('red'); await wait(() => a.humans.find(p => p.id === b.state!.id)?.team === 'red', 'team switch broadcast');
    await wait(() => a.state?.players.length === 2 && b.state?.players.length === 2, 'bot settings broadcast');
    await delay(200);
    const idle = { ...a.state!.metrics };
    await delay(1000);
    const polls = a.state!.metrics.polls - idle.polls;
    assert.ok(polls >= 8 && polls <= 12, `independent timer: ${polls} polls in one second`);
    assert.equal(a.state!.metrics.writes, idle.writes, 'idle network snapshots cause no DOM writes');
    console.log(`PASS ${origin}: ${polls} lobby polls in one second, zero idle DOM writes, no render loop`);
    a.command('ready');
    await wait(() => a.ready === 1 && b.ready === 1 && a.state?.statusText.startsWith('1 / 2 ready') && b.state?.statusText.startsWith('1 / 2 ready'), 'READY UP click sends and broadcasts one ready');
    assert.deepEqual(a.state!.readySent, [{ type: 'ready', ready: true }]);
    assert.equal(a.state!.round!.phase, 'lobby');
    if (app) assert.equal(app.rooms.get(room)!.players.get(a.state!.id)!.state.ready, true, 'server records readiness');
    b.command('ready');
    await wait(() => a.ready === 2 && b.ready === 2 && a.state?.round?.phase === 'countdown' && b.state?.round?.phase === 'countdown', 'both ready broadcast and countdown');
    assert.deepEqual(b.state!.readySent, [{ type: 'ready', ready: true }]);
    const nextAt = a.state!.round!.nextAt; assert.equal(b.state!.round!.nextAt, nextAt);
    if (app) assert.ok([...app.rooms.get(room)!.players.values()].filter(p => !p.state.bot).every(p => p.state.ready));
    await wait(() => a.state?.round?.phase === 'playing' && b.state?.round?.phase === 'playing', 'actual synchronized match start');
    assert.equal(a.state!.round!.endsAt, b.state!.round!.endsAt);
    assert.ok(a.local!.alive && b.local!.alive); assert.ok(Date.now() >= nextAt);
    assert.ok(a.state!.stable && b.state!.stable);
    console.log(`PASS ${origin}: two isolated Node clients click CREATE/JOIN/READY; server records and broadcasts 1/2 then 2/2; both enter playing after the same countdown`);

    // A new room exercises force-start without reusing any ready state from the first match.
    a.command('create');
    await wait(() => a.state?.room !== room && a.local && a.state?.round?.phase === 'lobby' && a.state?.label === 'READY UP', 'create next room');
    const forcedRoom = a.state!.room;
    b.command('join', forcedRoom); a.command('no-bots');
    await wait(() => b.state?.room === forcedRoom && a.humans.length === 2 && b.humans.length === 2 && b.state?.label === 'READY UP', 'force-start room joined');
    assert.equal(a.ready, 0); assert.equal(b.ready, 0);
    b.command('start'); await wait(() => b.state!.startSent === 1, 'nonhost sent start');
    await delay(250); assert.equal(a.state!.round!.phase, 'lobby', 'server rejects nonhost start');
    a.command('start');
    await wait(() => a.state?.round?.phase === 'countdown' && b.state?.round?.phase === 'countdown', 'HOST START EARLY click');
    assert.equal(a.ready, 0); assert.equal(b.ready, 0);
    assert.equal(a.state!.round!.nextAt, b.state!.round!.nextAt);
    await wait(() => a.state?.round?.phase === 'playing' && b.state?.round?.phase === 'playing', 'forced match starts with unready humans');
    assert.ok(a.state!.stable && b.state!.stable);
    a.command('stop');
    await wait(() => b.state?.host === b.state?.id && b.humans.length === 1, 'host leaves and host role migrates');
    console.log(`PASS ${origin}: START EARLY starts both unready clients; nonhost start rejected; host departure migrates ownership`);
} finally {
    for (const c of clients) if (c.child.connected) c.command('stop');
    await Promise.all(clients.map(c => c.child.exitCode !== null ? undefined : new Promise<void>(resolve => c.child.once('exit', () => resolve()))));
    await app?.close();
}
