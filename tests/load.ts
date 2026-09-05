import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFile } from 'node:fs/promises';
import { WebSocket } from 'ws';
import { brain, botInput } from '../src/server/bots';
import { predictInput, reconcile } from '../src/client/prediction';
import { CLASS_IDS } from '../src/shared/weapons';
import type { ClientMessage, Input, PlayerState, RoundState, ServerMessage } from '../src/shared/types';

// This process has no access to the server simulation. It exercises the actual HTTP/WS production port.
const origin = process.env.GAME_URL ?? 'http://127.0.0.1:8080';
const seconds = Number(process.env.LOAD_SECONDS ?? 30);
const latency = Number(process.env.LOAD_LATENCY_MS ?? 0); // one-way application delay
const counts = (process.env.LOAD_COUNTS ?? '2,5,10').split(',').map(Number);
const bots = Number(process.env.LOAD_BOTS ?? 7);
assert.ok(seconds >= 5 && counts.every(n => n >= 1 && n <= 10) && latency >= 0);
const wait = async (fn: () => unknown, label: string, ms = 10000) => {
    const start = Date.now();
    while (!fn()) { if (Date.now() - start > ms) throw new Error(label); await delay(20); }
};
const percentile = (data: number[], p: number) => { const sorted = [...data].sort((a, b) => a - b); return sorted[Math.floor((sorted.length - 1) * p)] ?? 0; };
const health = async () => { const r = await fetch(origin + '/api/health'); assert.equal(r.status, 200); return r.json(); };
type View = { client: string; players: Map<string, PlayerState> };
let observations = new Map<number, View>();
let replicaErrors = 0;
function compareReplicas(n: number, client: Client) {
    const before = observations.get(n);
    if (!before) observations.set(n, { client: client.id, players: new Map(client.players) });
    else {
        if (before.players.size !== client.players.size) replicaErrors++;
        for (const [id, p] of client.players) {
            const q = before.players.get(id);
            if (!q) { replicaErrors++; continue; }
            for (const k of ['x', 'y', 'z', 'vx', 'vy', 'vz'] as const) if (Math.abs(p[k] - q[k]) > .006) replicaErrors++;
            for (const k of ['life', 'alive', 'hp', 'kills', 'deaths', 'team', 'classId'] as const) if (p[k] !== q[k]) replicaErrors++;
        }
    }
    // Bound observations even if a client drops or stalls.
    for (const key of observations.keys()) if (key < n - 100) observations.delete(key);
}
class Client {
    ws: WebSocket;
    id = ''; token = ''; room = ''; seq = 0; n = 0; receivedAt = 0; offset = 0;
    bytesIn = 0; bytesOut = 0; packets = 0; shots = 0; hits = 0; kills = 0;
    deathCorrections: number[] = [];
    correctionSpikes: unknown[] = [];
    desyncs = 0; errors: string[] = []; corrections: number[] = []; ackLag: number[] = []; gaps: number[] = [];
    pending: Input[] = []; outgoing: Input[] = []; players = new Map<string, PlayerState>();
    predicted?: PlayerState; round?: RoundState; ai = brain();
    running = false; timer?: ReturnType<typeof setTimeout>;
    moved = 0; measured = false;
    constructor(public index: number, room: string) {
        this.ws = new WebSocket(origin.replace(/^http/, 'ws') + '/ws');
        this.ws.on('open', () => this.send({ type: 'join', name: `Load ${index + 1}`, room, classId: CLASS_IDS[index % 4], team: index % 2 ? 'red' : 'blue' }));
        this.ws.on('error', e => this.errors.push(e.message));
        this.ws.on('close', (code, reason) => { if (this.running) this.errors.push(`Disconnected ${code} ${reason}`); });
        this.ws.on('message', data => {
            const size = Buffer.byteLength(data.toString());
            if (this.measured) { this.bytesIn += size + (size < 126 ? 2 : 4); this.packets++; }
            const m = JSON.parse(data.toString()) as ServerMessage;
            if (latency) setTimeout(() => this.receive(m), latency); else this.receive(m);
        });
    }
    send(m: ClientMessage) {
        const data = JSON.stringify(m);
        const transmit = () => { if (this.ws.readyState !== 1) return; this.ws.send(data); if (this.measured) this.bytesOut += Buffer.byteLength(data) + (data.length < 126 ? 6 : 8); };
        if (latency) setTimeout(transmit, latency); else transmit();
    }
    receive(m: ServerMessage) {
        if (m.type === 'welcome') { this.id = m.id; this.room = m.room; this.token = m.token; this.offset = m.serverTime + latency - Date.now(); }
        if (m.type === 'error') this.errors.push(m.message);
        if (m.type === 'events' && this.measured) {
            this.shots += m.events.filter(e => e.type === 'shot' && e.shooter === this.id).length;
            this.hits += m.events.filter(e => e.type === 'hit' && e.shooter === this.id).length;
            this.kills += m.events.filter(e => e.type === 'kill' && e.killer === this.id).length;
        }
        if (m.type !== 'snapshot') return;
        if (!m.full && m.base !== this.n) { this.desyncs++; this.send({ type: 'sync' }); return; }
        if (this.measured && this.receivedAt) this.gaps.push(Date.now() - this.receivedAt);
        this.receivedAt = Date.now(); this.n = m.n;
        if (m.full) this.players.clear();
        for (const p of m.players) {
            if (!this.players.has(p.id) && p.x === undefined) this.desyncs++;
            this.players.set(p.id, { ...this.players.get(p.id), ...p } as PlayerState);
        }
        for (const id of m.removed) this.players.delete(id);
        if (m.round) this.round = m.round;
        const local = this.players.get(this.id);
        if (!local) { this.desyncs++; return; }
        for (const p of this.players.values()) if (![p.x, p.y, p.z, p.yaw, p.pitch, p.hp].every(Number.isFinite) || Math.abs(p.x) > 38 || Math.abs(p.z) > 38 || p.y < -.1) this.desyncs++;
        const old = this.predicted;
        const replay = reconcile(local, this.pending, this.round?.phase === 'playing');
        this.predicted = replay.predicted; this.pending = replay.remaining;
        this.seq = Math.max(this.seq, local.ack);
        if (old?.life === local.life) {
            if (this.measured) {
                const error = Math.hypot(old.x - this.predicted.x, old.y - this.predicted.y, old.z - this.predicted.z);
                if (old.alive !== local.alive) this.deathCorrections.push(error);
                else {
                    this.corrections.push(error);
                    if (error > .1 && this.correctionSpikes.length < 20) this.correctionSpikes.push({ error, alive: local.alive, ack: local.ack, pending: this.pending.length, life: local.life });
                }
                this.ackLag.push(this.seq - local.ack);
            }
        } else { this.pending = []; this.outgoing = []; }
        if (this.measured) compareReplicas(m.n, this);
    }
    start() {
        this.running = true;
        let next = performance.now();
        const tick = () => {
            if (!this.running) return;
            if (this.predicted && this.round?.phase === 'playing') {
                const p = this.predicted;
                const i = botInput(p, this.ai, this.players.values(), this.round.mode, 'hard', Date.now() + this.offset);
                i.seq = ++this.seq; i.shotTime = Date.now() + this.offset - 100;
                const prev = { x: p.x, z: p.z };
                predictInput(p, i, true);
                if (this.measured) this.moved += Math.hypot(p.x - prev.x, p.z - prev.z);
                this.pending.push(i); this.outgoing.push(i);
                if (this.outgoing.length >= 2) this.send({ type: 'input', inputs: this.outgoing.splice(0, 2) });
                if (this.pending.length > 240) { this.desyncs++; this.pending = []; this.send({ type: 'sync' }); }
            }
            next += 1000 / 60;
            if (next < performance.now() - 100) next = performance.now();
            this.timer = setTimeout(tick, Math.max(0, next - performance.now()));
        };
        tick();
    }
    close() { this.running = false; clearTimeout(this.timer); this.ws.close(); }
}
const report = [];
for (const count of counts) {
    const clients: Client[] = [];
    observations = new Map(); replicaErrors = 0;
    try {
        const a = new Client(0, ''); clients.push(a);
        await wait(() => a.id && a.round, 'host joins');
        a.send({ type: 'configure', bots, scoreLimit: 200, duration: 1800000 });
        for (let i = 1; i < count; i++) clients.push(new Client(i, a.room));
        await wait(() => clients.every(c => c.id && c.players.size === count + bots), `${count} humans + ${bots} bots join`);
        for (const c of clients) c.send({ type: 'ready', ready: true });
        await wait(() => clients.every(c => c.round?.phase === 'playing'), 'all clients start together');
        assert.equal(new Set(clients.map(c => c.round!.endsAt)).size, 1);
        for (const c of clients) c.start();
        await delay(2500); // Warm up runtime and wait out spawn protection.
        const begin = await health(), started = Date.now();
        assert.equal(begin.players, count, 'run benchmarks against an isolated server');
        for (const c of clients) c.measured = true;
        const samples = [];
        while (Date.now() - started < seconds * 1000) { await delay(1000); samples.push(await health()); }
        const end = samples.at(-1)!, duration = (Date.now() - started) / 1000;
        for (const c of clients) c.measured = false;
        const row = {
            humans: count, bots, durationSeconds: +duration.toFixed(1), latencyMsOneWay: latency,
            tickHz: +((end.ticks - begin.ticks) / duration).toFixed(2),
            meanTickMs: +((end.totalTickMs - begin.totalTickMs) / (end.ticks - begin.ticks)).toFixed(3),
            maxWindowP95Ms: Math.max(...samples.map(s => s.tickP95Ms)),
            peakTickMs: Math.max(...samples.map(s => s.peakTickMs)),
            overBudgetTicks: end.overBudgetTicks - begin.overBudgetTicks,
            maxQueueBytes: Math.max(...samples.map(s => s.queuedBytes)),
            replicaErrors,
            clients: clients.map(c => ({ name: `Load ${c.index + 1}`, downKBps: +(c.bytesIn / duration / 1000).toFixed(2), upKBps: +(c.bytesOut / duration / 1000).toFixed(2), shots: c.shots, hits: c.hits, kills: c.kills, movedMetres: +c.moved.toFixed(1), desyncs: c.desyncs, errors: c.errors, deathCorrectionMaxMetres: +Math.max(0, ...c.deathCorrections).toFixed(4), correctionSpikes: c.correctionSpikes, predictionP95Metres: +percentile(c.corrections, .95).toFixed(4), predictionP99Metres: +percentile(c.corrections, .99).toFixed(4), maxAckLag: Math.max(...c.ackLag), snapshotGapP99Ms: percentile(c.gaps, .99), maxSnapshotGapMs: Math.max(...c.gaps) }))
        };
        report.push(row); console.log(JSON.stringify(row, null, 2));
        if (process.env.LOAD_REPORT) await writeFile(process.env.LOAD_REPORT, JSON.stringify({ date: new Date().toISOString(), origin, passed: false, report }, null, 2) + '\n');
        assert.ok(row.tickHz >= 57, 'sustain near-60Hz');
        assert.ok(row.maxWindowP95Ms < 16.67, 'tick processing within budget');
        assert.equal(replicaErrors, 0, 'all clients reconstruct the same world');
        for (const c of row.clients) {
            assert.equal(c.desyncs, 0, 'no baseline gaps or invalid states'); assert.deepEqual(c.errors, []);
            assert.ok(c.shots > 0 && c.movedMetres > 5, 'every simulated human moves and shoots');
            assert.ok(c.maxAckLag < 90, 'inputs do not build an unbounded queue');
            assert.ok(c.maxSnapshotGapMs < 500, 'no snapshot stalls');
            assert.ok(c.predictionP99Metres < .5, 'prediction remains close to authority');
            assert.ok(c.downKBps < 50, 'per-client bandwidth remains bounded');
        }
    } finally { for (const c of clients) c.close(); await delay(300); }
}
if (process.env.LOAD_REPORT) await writeFile(process.env.LOAD_REPORT, JSON.stringify({ date: new Date().toISOString(), origin, passed: true, report }, null, 2) + '\n');
console.log('PASS: production multi-client load, bandwidth, tick budget, replica consistency and prediction checks');
