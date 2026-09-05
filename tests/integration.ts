import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { createGameServer } from '../src/server/index';
import { neutralInput, moveState } from '../src/shared/movement';
import { CLASSES, WEAPONS } from '../src/shared/weapons';
import type { ClassId, ClientMessage, GameEvent, Input, PlayerState, ServerMessage } from '../src/shared/types';
const app = createGameServer();
await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
const address = app.server.address();
assert.ok(address && typeof address !== 'string');
const url = `ws://127.0.0.1:${address.port}/ws`;
const waitFor = async (fn: () => boolean, label: string, timeout = 3500) => { const start = Date.now(); while (!fn()) {
    if (Date.now() - start > timeout)
        throw new Error(`Timed out: ${label}`);
    await delay(10);
} };
class Client {
    ws = new WebSocket(url);
    id = '';
    token = '';
    players = new Map<string, PlayerState>();
    events: GameEvent[] = [];
    snapshots = 0;
    delta = 0;
    fullBytes = 0;
    deltaBytes = 0;
    seq = 0;
    timer?: ReturnType<typeof setTimeout>;
    input = neutralInput();
    running = false;
    phase = '';
    constructor(public name: string, token?: string) { this.ws.on('open', () => this.send({ type: 'join', name, room: 'QA', classId: 'hunter', team: name === 'Alpha' ? 'blue' : 'red', token })); this.ws.on('message', raw => { const m = JSON.parse(raw.toString()) as ServerMessage; if (m.type === 'welcome') {
        this.id = m.id;
        this.token = m.token;
    } if (m.type === 'snapshot') {
        if (m.full) {
            this.players.clear();
            this.fullBytes += Buffer.byteLength(raw.toString());
        }
        else {
            this.delta++;
            this.deltaBytes += Buffer.byteLength(raw.toString());
        }
        for (const p of m.players)
            this.players.set(p.id, { ...this.players.get(p.id), ...p } as PlayerState);
        for (const id of m.removed)
            this.players.delete(id);
        this.phase = m.round.phase;
        this.snapshots++;
        this.seq = Math.max(this.seq, this.players.get(this.id)?.ack ?? 0);
    } if (m.type === 'events')
        this.events.push(...m.events); }); }
    send(m: ClientMessage) { if (this.ws.readyState === WebSocket.OPEN)
        this.ws.send(JSON.stringify(m)); }
    start() { this.running = true; let next = Date.now(); const tick = () => { if (!this.running)
        return; this.send({ type: 'input', inputs: [{ ...this.input, seq: ++this.seq, shotTime: Date.now() - 100 }] }); next += 1000 / 60; this.timer = setTimeout(tick, Math.max(0, next - Date.now())); }; tick(); }
    stop() { this.running = false; clearTimeout(this.timer); }
    close() { this.stop(); this.ws.close(); }
}
const clients: Client[] = [];
try {
    const a = new Client('Alpha'), b = new Client('Bravo');
    clients.push(a, b);
    await waitFor(() => !!a.id && !!b.id, 'two clients join');
    const r = app.rooms.get('QA')!;
    a.send({ type: 'configure', bots: 0 });
    a.send({ type: 'start' });
    await waitFor(() => a.phase === 'playing' && b.phase === 'playing', 'round starts');
    a.start();
    b.start();
    assert.equal(r.players.size, 2);
    const actorA = r.players.get(a.id)!, actorB = r.players.get(b.id)!;
    Object.assign(actorA.state, moveState(32, 0, 28), { protectionEnd: 0 });
    Object.assign(actorB.state, moveState(32, 0, -10), { protectionEnd: 0 });
    a.input.forward = 1;
    await delay(500);
    a.input.forward = 0;
    await delay(130);
    assert.ok(a.players.get(a.id)!.z < 25);
    assert.ok(Math.abs(a.players.get(a.id)!.z - b.players.get(a.id)!.z) < 0.7);
    console.log('PASS: two real WebSocket clients see authoritative movement');
    a.input.jump = true;
    await delay(120);
    a.input.jump = false;
    assert.ok(b.players.get(a.id)!.y > 0.3);
    await delay(750);
    const reset = (classId: ClassId, targetHp = 100) => { a.input = neutralInput(); b.input = neutralInput(); actorA.state.classId = classId; actorA.pendingClass = undefined; r.spawn(actorA, Date.now()); r.spawn(actorB, Date.now()); Object.assign(actorA.state, moveState(32, 0, 18), { protectionEnd: 0 }); Object.assign(actorB.state, moveState(32, 0, 8), { protectionEnd: 0, hp: targetHp, maxHp: targetHp }); actorA.nextShot = 0; a.events = []; b.events = []; r.history.frames = []; r.history.record(Date.now() - 150, [actorA.state, actorB.state]); };
    for (const cls of ['hunter', 'triggerman', 'vince', 'runngun'] as ClassId[]) {
        reset(cls, cls === 'hunter' ? 100 : 1000);
        a.input.aim = true;
        a.input.pitch = cls === 'hunter' ? 0 : Math.atan2(-0.6, 10);
        await delay(250);
        const before = actorA.state.ammo;
        a.input.fire = true;
        await waitFor(() => a.events.some(e => e.type === 'hit' && e.shooter === a.id), `${cls} hits real client`);
        a.input.fire = false;
        await delay(100);
        assert.ok(actorA.state.ammo < before);
        assert.ok(actorB.state.hp < actorB.state.maxHp);
        console.log(`PASS: ${cls} fires and damages another real client (${actorB.state.maxHp - actorB.state.hp} damage)`);
        if (cls === 'hunter') {
            assert.ok(a.events.some(e => e.type === 'kill' && e.headshot));
            assert.ok(b.events.some(e => e.type === 'kill'));
            await waitFor(() => actorB.state.alive, 'victim respawns', 3000);
            assert.ok(actorB.state.protectionEnd > Date.now());
            console.log('PASS: headshot, killfeed, score, timed respawn and spawn protection');
        }
        a.input.reload = true;
        await delay(100);
        a.input.reload = false;
        await waitFor(() => actorA.state.reloadEnd > 0, `${cls} starts reload`);
        await waitFor(() => actorA.state.reloadEnd === 0, `${cls} reload completes`, 3000);
        assert.equal(actorA.state.ammo, WEAPONS[CLASSES[cls].weapon].magazine);
    }
    reset('hunter');
    actorA.aimTime = 1;
    actorA.rtt = 150;
    const past = Date.now();
    r.history.frames = [];
    r.history.record(past - 100, [actorA.state, actorB.state]);
    actorB.state.x = 35;
    r.history.record(past, [actorA.state, actorB.state]);
    // Send a historical aim through the real socket, matching the shooter's interpolated view.
    a.stop();
    b.stop();
    a.send({ type: 'input', inputs: [{ ...neutralInput(++a.seq), aim: true, fire: true, shotTime: past - 100 }] });
    await waitFor(() => actorB.state.hp < 100, 'lag compensated real client shot');
    console.log('PASS: hitscan rewind hits the target at the historical visible position');
    const before = actorA.state.x;
    a.send({ type: 'input', inputs: [{ ...neutralInput(++a.seq), forward: 999 } as Input] });
    await delay(100);
    assert.ok(Math.abs(actorA.state.x - before) < .01);
    console.log('PASS: malformed speed input rejected');
    r.round.scoreLimit = 1;
    actorA.state.kills = 1;
    await waitFor(() => a.phase === 'results' && b.phase === 'results', 'round results');
    r.round.nextAt = Date.now() + 100;
    await waitFor(() => a.phase === 'lobby' && b.phase === 'lobby', 'return to the same lobby');
    assert.equal(actorA.state.kills, 1);
    a.send({ type: 'ready', ready: true });
    b.send({ type: 'ready', ready: true });
    await waitFor(() => a.phase === 'playing', 'ready up for another round');
    assert.equal(actorA.state.kills, 0);
    console.log('PASS: score limit, results, lobby return, ready countdown and score reset');
    const token = b.token, id = b.id;
    b.close();
    await delay(100);
    const resumed = new Client('Bravo', token);
    clients.push(resumed);
    await waitFor(() => !!resumed.id, 'reconnect');
    assert.equal(resumed.id, id);
    assert.equal(r.players.size, 2);
    assert.equal(r.players.get(id)!.state.alive, true);
    console.log('PASS: reconnect restores existing identity without duplicate players');
    assert.ok(a.delta > 20);
    assert.ok(a.deltaBytes / a.delta < a.fullBytes / (a.snapshots - a.delta));
    const health = await (await fetch(`http://127.0.0.1:${address.port}/api/health`)).json() as {
        tickRate: number;
        tickMs: number;
        peakTickMs: number;
    };
    console.log('METRICS', JSON.stringify({ ...health, deltaSnapshots: a.delta, meanDeltaBytes: Math.round(a.deltaBytes / a.delta), meanFullBytes: Math.round(a.fullBytes / (a.snapshots - a.delta)) }));
    assert.ok(health.tickRate >= 55);
}
finally {
    for (const c of clients)
        c.close();
    await app.close();
}
