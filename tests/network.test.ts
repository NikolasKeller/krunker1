import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket as RealWebSocket, WebSocketServer } from 'ws';
import { Network, CONNECT_TIMEOUT_MS, JOIN_RETRY_MS, SLOW_CONNECTION_MS, CONNECTION_DEAD_MS, RECONNECT_BASE_MS, RECONNECT_MAX_MS, retryDelay } from '../src/client/network';
import { createGameServer } from '../src/server/index';
import { Room } from '../src/server/simulation';
import { decodeClientMessage, WIRE_PROTOCOL, INPUT_SEND_MS, MAX_INPUT_BATCH, MAX_PENDING_INPUTS, MAX_IN_FLIGHT_INPUTS } from '../src/shared/protocol';
import { neutralInput, moveState } from '../src/shared/movement';
import type { ClientMessage, ServerMessage } from '../src/shared/types';

const config = { name: 'Alpha', room: '', classId: 'hunter', team: 'blue', create: true } as const;
function globals(t: TestContext, values: Record<string, unknown>) {
    for (const [key, value] of Object.entries(values)) {
        const original = Object.getOwnPropertyDescriptor(globalThis, key);
        Object.defineProperty(globalThis, key, { configurable: true, value });
        t.after(() => {
            if (original) Object.defineProperty(globalThis, key, original);
            else Reflect.deleteProperty(globalThis, key);
        });
    }
}
class Socket {
    static OPEN = 1;
    static instances: Socket[] = [];
    readyState = 0;
    bufferedAmount = 0;
    sent: ClientMessage[] = [];
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    onclose?: (event: { code: number }) => void;
    onerror?: () => void;
    constructor(public url: string) { Socket.instances.push(this); }
    send(data: string | Uint8Array) {
        assert.equal(this.readyState, Socket.OPEN, 'nothing is sent before open');
        this.sent.push(decodeClientMessage(data));
    }
    open() { this.readyState = Socket.OPEN; this.onopen?.(); }
    receive(message: ServerMessage) { this.onmessage?.({ data: JSON.stringify(message) }); }
    close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
}
function setup(t: TestContext, storage = { getItem: (_key: string): string | null => null, setItem: (_key: string, _value: string) => {} }) {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    Socket.instances = [];
    t.mock.method(Math, 'random', () => 1);
    globals(t, { WebSocket: Socket, location: { protocol: 'https:', host: 'arena.example' }, sessionStorage: storage });
    const net = new Network();
    t.after(() => net.disconnect());
    net.connect(config);
    return { net, ws: Socket.instances[0] };
}
function assignment(ws: Socket) {
    const room = new Room('ABCDE'), p = room.add('Alpha', 'hunter', 'blue').state;
    ws.receive({ type: 'welcome', id: p.id, room: room.id, host: p.id, token: 'session', serverTime: Date.now() });
    return () => ws.receive({ type: 'snapshot', n: 1, base: 0, time: Date.now(), full: true, players: [p], removed: [], round: room.round });
}

test('a delayed upgrade sends join only after open and retries until welcome AND the player snapshot arrive', t => {
    const { net, ws } = setup(t);
    assert.equal(ws.url, 'wss://arena.example/ws');
    t.mock.timers.tick(900);
    assert.equal(ws.sent.length, 0);
    ws.open();
    assert.equal(net.status, 'JOINING LOBBY');
    assert.equal(ws.sent.filter(m => m.type === 'join').length, 1);
    t.mock.timers.tick(JOIN_RETRY_MS);
    assert.equal(ws.sent.filter(m => m.type === 'join').length, 2, 'lost first join is retried');
    const snapshot = assignment(ws);
    assert.notEqual(net.status, 'CONNECTED', 'welcome alone cannot enable Ready');
    t.mock.timers.tick(JOIN_RETRY_MS * 2);
    assert.ok(ws.sent.some(m => m.type === 'sync'), 'missing initial snapshot is requested');
    snapshot();
    assert.equal(net.status, 'CONNECTED');
    assert.ok(net.local);
    const joins = ws.sent.filter(m => m.type === 'join').length;
    t.mock.timers.tick(JOIN_RETRY_MS);
    assert.equal(ws.sent.filter(m => m.type === 'join').length, joins);
});

test('an open socket with pongs but no assignment reconnects even without a close event', t => {
    const { net, ws } = setup(t);
    ws.open();
    // A broken intermediary can keep the transport open indefinitely.
    ws.close = () => { ws.readyState = 2; };
    ws.receive({ type: 'pong', time: Date.now(), serverTime: Date.now() });
    t.mock.timers.tick(CONNECT_TIMEOUT_MS);
    assert.equal(net.status, 'RECONNECTING');
    t.mock.timers.tick(RECONNECT_BASE_MS);
    assert.equal(Socket.instances.length, 2);
    const next = Socket.instances[1]; next.open();
    ws.onerror?.(); ws.onclose?.({ code: 1006 });
    assert.equal(net.status, 'REJOINING LOBBY', 'stale socket callbacks cannot change the new connection');
    assignment(next)();
    assert.equal(net.status, 'CONNECTED');
});

test('a stalled upgrade is bounded and repeated failed handshakes retain reconnect backoff', t => {
    const { net } = setup(t);
    t.mock.timers.tick(CONNECT_TIMEOUT_MS);
    t.mock.timers.tick(RECONNECT_BASE_MS);
    assert.equal(Socket.instances.length, 2);
    Socket.instances[1].open();
    t.mock.timers.tick(CONNECT_TIMEOUT_MS);
    t.mock.timers.tick(RECONNECT_BASE_MS);
    assert.equal(Socket.instances.length, 2, 'open alone does not reset backoff');
    t.mock.timers.tick(RECONNECT_BASE_MS);
    assert.equal(Socket.instances.length, 3);
    assert.equal(net.status, 'RECONNECTING');
});

test('unavailable session storage cannot prevent joining, welcome callbacks, or in-memory session resumption', t => {
    const { net, ws } = setup(t, { getItem() { throw new Error('Storage blocked'); }, setItem() { throw new Error('Storage blocked'); } });
    let welcomed = 0; net.onWelcome = () => welcomed++;
    ws.open();
    assert.equal(ws.sent[0].type, 'join');
    assignment(ws)();
    assert.equal(net.status, 'CONNECTED');
    assert.equal(welcomed, 1);
    net.connect({ ...config, room: net.room, create: false });
    const resumed = Socket.instances[1]; resumed.open();
    assert.equal((resumed.sent[0] as Extract<ClientMessage, { type: 'join' }>).token, 'session');
});

test('a dead connection resumes its room and session only after sustained silence and backoff', t => {
    const { net, ws } = setup(t);
    t.mock.timers.tick(900); ws.open();
    assignment(ws)();
    const room = net.room;
    t.mock.timers.tick(7500);
    assert.equal(Socket.instances.length, 1);
    assert.equal(net.status, 'CONNECTION SLOW');
    t.mock.timers.tick(CONNECTION_DEAD_MS);
    assert.equal(Socket.instances.length, 1, 'a dead socket still respects backoff');
    t.mock.timers.tick(RECONNECT_BASE_MS);
    assert.equal(Socket.instances.length, 2);
    const resumed = Socket.instances[1]; resumed.open();
    const join = resumed.sent[0] as Extract<ClientMessage, { type: 'join' }>;
    assert.equal(join.room, room); assert.equal(join.create, false); assert.equal(join.token, 'session');
});


for (const latency of [1000, 2000, 3000, 4000]) {
    test(`${latency}ms per connection stage reaches play and survives repeated stalls on the same socket`, t => {
        const { net, ws } = setup(t);
        const room = new Room('SLOW'); room.botCount = 0;
        const actor = room.add('Alpha', 'hunter', 'blue');
        // Independently delay upgrade, join upload, welcome and initial snapshot.
        t.mock.timers.tick(latency); ws.open();
        t.mock.timers.tick(latency * 2);
        ws.receive({ type: 'welcome', id: actor.state.id, room: room.id, host: actor.state.id, token: 'slow-session', serverTime: Date.now() });
        t.mock.timers.tick(latency);
        let n = 0;
        const snapshot = () => ws.receive({ type: 'snapshot', n: ++n, base: 0, full: true, time: Date.now(), players: [{ ...actor.state }], removed: [], round: { ...room.round } });
        snapshot();
        net.send({ type: 'ready', ready: true });
        assert.ok(ws.sent.some(m => m.type === 'ready'));
        t.mock.timers.tick(latency); actor.state.ready = true; room.updateLobby(Date.now());
        t.mock.timers.tick(3000); room.updateLobby(Date.now());
        t.mock.timers.tick(latency); snapshot();
        assert.equal(net.round?.phase, 'playing');
        for (let stall = 0; stall < 4; stall++) {
            const id = net.id;
            t.mock.timers.tick(latency);
            assert.equal(ws.readyState, Socket.OPEN);
            assert.equal(net.id, id);
            snapshot();
        }
        assert.equal(net.status, 'CONNECTED');
        assert.ok(net.predicted?.alive);
        assert.equal(Socket.instances.length, 1, 'no reconnect cycle even with a 16 second admission');
    });
}

test('late snapshots report a slow connection, request state, and never replace a responsive socket', t => {
    const { net, ws } = setup(t); ws.open(); const snapshot = assignment(ws); snapshot();
    const id = net.id, predicted = net.predicted;
    for (let elapsed = 0; elapsed < CONNECTION_DEAD_MS * 2; elapsed += 1500) {
        t.mock.timers.tick(1500);
        ws.receive({ type: 'pong', time: Date.now() - 4000, serverTime: Date.now() });
    }
    assert.equal(net.status, 'CONNECTION SLOW');
    assert.ok(ws.sent.some(m => m.type === 'sync'));
    assert.equal(Socket.instances.length, 1);
    assert.equal(net.id, id); assert.equal(net.predicted, predicted);
    snapshot(); assert.equal(net.status, 'CONNECTED');
});

test('handshake and reconnect retries use bounded exponential backoff with jitter', t => {
    t.mock.method(Math, 'random', () => 0);
    const low = retryDelay(0);
    t.mock.method(Math, 'random', () => 1);
    assert.equal(low, RECONNECT_BASE_MS * .75);
    assert.equal(retryDelay(0), RECONNECT_BASE_MS);
    assert.equal(retryDelay(1), RECONNECT_BASE_MS * 2);
    assert.equal(retryDelay(100), RECONNECT_MAX_MS);
    const { ws } = setup(t); ws.open();
    t.mock.timers.tick(JOIN_RETRY_MS); assert.equal(ws.sent.filter(m => m.type === 'join').length, 2);
    t.mock.timers.tick(JOIN_RETRY_MS); assert.equal(ws.sent.filter(m => m.type === 'join').length, 2);
    t.mock.timers.tick(JOIN_RETRY_MS); assert.equal(ws.sent.filter(m => m.type === 'join').length, 3);
});

test('real delayed WebSocket handshakes recover a lost join and lost assignment without duplicate rooms or players', async t => {
    const app = createGameServer();
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address(); assert.ok(address && typeof address === 'object');
    const proxy = http.createServer(), wss = new WebSocketServer({ noServer: true });
    const sockets = new Set<RealWebSocket>();
    let connectionCount = 0, droppedJoins = 0, droppedWelcomes = 0;
    proxy.on('upgrade', (req, socket, head) => {
        // TLS/edge/upstream setup takes hundreds of milliseconds on a remote deployment.
        setTimeout(() => wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws)), 800);
    });
    wss.on('connection', (down: RealWebSocket) => {
        const index = connectionCount++;
        const up = new RealWebSocket(`ws://127.0.0.1:${address.port}/ws`, down.protocol || undefined);
        sockets.add(up); sockets.add(down);
        let joins = 0;
        const pending: { data: Buffer; binary: boolean }[] = [];
        up.on('open', () => { for (const message of pending) up.send(message.data, { binary: message.binary }); });
        down.on('message', (data, binary) => {
            const raw = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
            const message = decodeClientMessage(binary ? raw : raw.toString());
            if (message.type === 'join') {
                joins++;
                if (index === 0 && joins === 1) { droppedJoins++; return; }
            }
            if (up.readyState === RealWebSocket.OPEN) up.send(raw, { binary });
            else pending.push({ data: raw, binary });
        });
        up.on('message', (data, binary) => {
            if (index === 1 && joins < 2) {
                if (!binary && JSON.parse(data.toString()).type === 'welcome') droppedWelcomes++;
                return;
            }
            if (down.readyState === RealWebSocket.OPEN) down.send(data, { binary });
        });
        down.on('close', () => up.close()); up.on('close', () => down.close());
        down.on('error', () => {}); up.on('error', () => {});
    });
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const edge = proxy.address(); assert.ok(edge && typeof edge === 'object');
    globals(t, { WebSocket: RealWebSocket, location: { protocol: 'http:', host: `127.0.0.1:${edge.port}` }, sessionStorage: { getItem: () => null, setItem() {} } });
    const a = new Network(), b = new Network();
    async function wait(fn: () => unknown, label: string) {
        const deadline = Date.now() + 7000;
        while (!fn()) { assert.ok(Date.now() < deadline, label); await delay(20); }
    }
    try {
        a.connect(config);
        await wait(() => a.local, 'lost first join recovers');
        b.connect({ ...config, name: 'Bravo', room: a.room, team: 'red', create: false });
        await wait(() => b.local && a.players.has(b.id), 'lost welcome recovers the existing assignment');
        assert.equal(droppedJoins, 1); assert.equal(droppedWelcomes, 1);
        assert.equal(connectionCount, 2, 'both handshakes recover on their original socket');
        assert.equal(app.rooms.size, 1);
        assert.equal([...app.rooms.values()][0].players.size, 2 + [...app.rooms.values()][0].botCount);
        a.send({ type: 'ready', ready: true }); b.send({ type: 'ready', ready: true });
        await wait(() => a.round?.phase === 'playing' && b.round?.phase === 'playing', 'both clients start the same match');
        assert.equal(a.round?.endsAt, b.round?.endsAt);
    } finally {
        a.disconnect(); b.disconnect();
        for (const ws of sockets) ws.terminate();
        await new Promise<void>(resolve => wss.close(() => resolve()));
        await new Promise<void>(resolve => proxy.close(() => resolve()));
        await app.close();
    }
});

test('inputs remain ordered and bounded while the socket is blocked, and serialize at 20 Hz', t => {
    const { net, ws } = setup(t); ws.open(); assignment(ws)();
    for (let seq = 1; seq <= 3; seq++) net.input(neutralInput(seq));
    assert.equal(ws.sent.filter(m => m.type === 'input').length, 0, 'rendering does not send packets');
    net.inputs.flush(ws, 1000);
    const batch = ws.sent.find(m => m.type === 'input');
    assert.ok(batch?.type === 'input');
    assert.deepEqual(batch.inputs.map(i => i.seq), [1, 2, 3]);
    ws.bufferedAmount = 100;
    for (let seq = 4; seq <= 243; seq++) {
        net.input({ ...neutralInput(seq), forward: seq < 238 ? 1 : 0, strafe: seq >= 241 ? -1 : 0, jump: seq === 242 });
        net.inputs.flush(ws, 1000 + seq * INPUT_SEND_MS);
    }
    assert.equal(ws.sent.filter(m => m.type === 'input').length, 1, 'blocked transport does not queue sends');
    assert.ok(net.pending.length <= MAX_PENDING_INPUTS);
    assert.equal(net.outgoing.length, 240, 'all four seconds of unsent movement survive');
    ws.bufferedAmount = 0;
    for (let packet = 0; packet < 20; packet++) {
        const now = 100000 + packet * INPUT_SEND_MS;
        net.inputs.flush(ws, now);
        assert.equal(net.inputs.flush(ws, now + 1), 0, 'catch-up never exceeds 20 packets/s');
    }
    const sequences = ws.sent.filter(m => m.type === 'input').flatMap(m => m.inputs.map(i => i.seq));
    assert.deepEqual(sequences, Array.from({ length: 243 }, (_, i) => i + 1));
    assert.equal(net.inputs.dropped, 0);
    const latest = ws.sent.at(-1); assert.ok(latest?.type === 'input');
    assert.equal(latest.inputs.at(-1)?.seq, 243);
    assert.deepEqual(latest.inputs.slice(-3).map(i => [i.forward, i.strafe, i.jump]), [[0, -1, false], [0, -1, true], [0, -1, false]], 'newest stop, turn and jump edges survive coalescing');
});


test('cached arena-v1 clients retain JSON and arena-v2/v3 clients retain binary snapshots', async () => {
    const app = createGameServer();
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address(); assert.ok(address && typeof address === 'object');
    try {
        for (const protocol of ['arena-v1', 'arena-v2', WIRE_PROTOCOL]) {
            const ws = new RealWebSocket(`ws://127.0.0.1:${address.port}/ws`, protocol);
            try {
                await new Promise<void>((resolve, reject) => {
                    ws.once('error', reject);
                    ws.once('open', () => ws.send(JSON.stringify({ ...config, type: 'join' })));
                    ws.on('message', (data, binary) => {
                        if (!binary && JSON.parse(data.toString()).type !== 'snapshot') return;
                        try { assert.equal(binary, protocol !== 'arena-v1'); resolve(); } catch (error) { reject(error); }
                    });
                });
            } finally { ws.terminate(); }
        }
    } finally { await app.close(); }
});


test('acknowledgements bound inputs hidden in a kernel or proxy even when bufferedAmount is zero', t => {
    const { net, ws } = setup(t); ws.open(); assignment(ws)();
    for (let seq = 1; seq <= 1000; seq++) {
        net.input(neutralInput(seq)); net.inputs.flush(ws, seq * INPUT_SEND_MS);
    }
    const sent = ws.sent.filter(m => m.type === 'input');
    assert.equal(sent.reduce((n, m) => n + m.inputs.length, 0), MAX_IN_FLIGHT_INPUTS);
    assert.equal(net.inputs.inFlight.length, MAX_IN_FLIGHT_INPUTS);
    assert.ok(net.pending.length <= MAX_PENDING_INPUTS);
    assert.equal(ws.bufferedAmount, 0, 'a locally drained socket is not proof of delivery');
    net.inputs.acknowledge(MAX_IN_FLIGHT_INPUTS);
    net.inputs.flush(ws, 100000);
    const latest = ws.sent.at(-1); assert.ok(latest?.type === 'input');
    assert.equal(latest.inputs[0].seq, 1000 - MAX_PENDING_INPUTS + 1, 'an outage beyond retention resumes from the oldest retained command');
    assert.equal(net.inputs.inFlight.length, MAX_INPUT_BATCH);
});


test('prediction advances independently of discarded uploads, with bounded local replay history', t => {
    const { net, ws } = setup(t); ws.open(); assignment(ws)();
    Object.assign(net.local!, moveState(34, 0, 24));
    net.predicted = { ...net.local! }; net.round!.phase = 'playing';
    ws.bufferedAmount = 100;
    for (let seq = 1; seq <= MAX_PENDING_INPUTS + 120; seq++) {
        const before = net.predicted!.z;
        // Reverse before reaching map boundaries; neither queue capacity nor
        // history eviction may remove a local simulation step.
        net.input({ ...neutralInput(seq), forward: Math.floor((seq - 1) / 60) % 2 ? -1 : 1 });
        net.inputs.flush(ws, seq * INPUT_SEND_MS);
        if (seq % 60 > 12) assert.ok(Math.abs(net.predicted!.z - before) > .15, `local step ${seq} advances`);
        if (seq > MAX_PENDING_INPUTS && seq % 3 === 0) {
            const position: number = net.predicted!.z;
            ws.receive({ type: 'snapshot', n: seq, base: 0, time: Date.now(), full: true, players: [{ ...net.local!, hp: 80 }], removed: [] });
            assert.equal(net.predicted!.z, position, 'an ACK older than retained replay history cannot erase movement');
            assert.equal(net.predicted!.hp, 80, 'gameplay updates still apply during an upload outage');
        }
    }
    assert.equal(net.pending.length, MAX_PENDING_INPUTS);
    assert.equal(net.predictionHistory.pending.length, MAX_PENDING_INPUTS, 'replay memory stays bounded without stalling simulation');
});

test('remote interpolation reserves two snapshots behind one-way delivery latency', t => {
    const { net, ws } = setup(t); ws.open(); assignment(ws)();
    net.ping = 160;
    const now = net.serverNow, p = { ...net.local!, id: 'remote' };
    net.frames = [200, 150, 100].map(age => ({ time: now - age, players: new Map([[p.id, { ...p, x: (200 - age) / 100 }]]) }));
    assert.equal(net.interpolationDelay, 180);
    assert.ok(Math.abs(net.remotePlayers()[0].x - .2) < 1e-9, 'sample is interpolated instead of clamping to the latest arrival');
    t.mock.timers.tick(16);
    assert.ok(Math.abs(net.remotePlayers()[0].x - .36) < 1e-9, 'remote moves between snapshots');
    t.mock.timers.tick(2000);
    assert.equal(net.remotePlayers()[0].x, 1, 'a long outage holds the latest state instead of extrapolating through walls');
});


test('a respawn does not reopen the transmission window for still-unacknowledged packets', t => {
    const { net, ws } = setup(t); ws.open(); assignment(ws)();
    for (let seq = 1; seq <= MAX_IN_FLIGHT_INPUTS; seq++) {
        net.input(neutralInput(seq)); net.inputs.flush(ws, seq * INPUT_SEND_MS);
    }
    ws.receive({ type: 'snapshot', n: 2, base: 0, time: Date.now(), full: true, players: [{ ...net.local!, life: net.local!.life + 1 }], removed: [] });
    for (let seq = MAX_IN_FLIGHT_INPUTS + 1; seq <= MAX_IN_FLIGHT_INPUTS + 30; seq++) { net.input(neutralInput(seq)); net.inputs.flush(ws, seq * INPUT_SEND_MS); }
    assert.equal(net.inputs.inFlight.length, MAX_IN_FLIGHT_INPUTS);
    assert.equal(ws.sent.filter(m => m.type === 'input').reduce((n, m) => n + m.inputs.length, 0), MAX_IN_FLIGHT_INPUTS);
    ws.receive({ type: 'snapshot', n: 3, base: 0, time: Date.now(), full: true, players: [{ ...net.local!, ack: 30 }], removed: [] });
    net.inputs.flush(ws, 100000);
    const packet = ws.sent.at(-1); assert.ok(packet?.type === 'input'); assert.equal(packet.inputs.at(-1)?.seq, MAX_IN_FLIGHT_INPUTS + MAX_INPUT_BATCH);
});

test('partial acknowledgement credit cannot deadlock an ordered recovery backlog', t => {
    const { net, ws } = setup(t); ws.open(); assignment(ws)();
    for (let seq = 1; seq <= MAX_IN_FLIGHT_INPUTS + 120; seq++) {
        net.input(neutralInput(seq)); net.inputs.flush(ws, seq * INPUT_SEND_MS);
    }
    net.inputs.acknowledge(1); net.inputs.flush(ws, 100000);
    const packet = ws.sent.at(-1); assert.ok(packet?.type === 'input');
    assert.deepEqual(packet.inputs.map(i => i.seq), [MAX_IN_FLIGHT_INPUTS + 1]);
    assert.equal(net.inputs.inFlight.length, MAX_IN_FLIGHT_INPUTS);
});

test('same-life snapshots cannot change local aim or turn cosmetic drift into movement', t => {
    const { net, ws } = setup(t); ws.open(); assignment(ws)();
    Object.assign(net.predicted!, moveState(34, 0, 24), { yaw: 1.1, pitch: -.4 });
    const before = { ...net.predicted! };
    for (let n = 2; n <= 101; n++) {
        ws.receive({ type: 'snapshot', n, base: 0, full: true, time: Date.now(), players: [{ ...before, z: before.z + .06, yaw: -2, pitch: 1, hp: 50 }], removed: [] });
        assert.equal(net.predicted!.z, before.z); assert.equal(net.predicted!.yaw, before.yaw); assert.equal(net.predicted!.pitch, before.pitch);
        assert.equal(net.predicted!.hp, 50);
    }
    assert.ok(Math.abs(net.movementMetrics.rawMetres.p95 - .06) < 1e-12, 'instrumentation records the disagreement before suppression');
    assert.equal(net.movementMetrics.appliedMetres.max, 0);
    assert.equal(net.movementMetrics.renderedSnapshotMetres.max, 0);
    assert.equal(net.movementMetrics.correctionsPerSecond, 0);
});
