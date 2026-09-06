import http from 'node:http';
import { connectionInfo } from './connection';
import { randomBytes } from 'node:crypto';
import { serveClient } from './static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { WebSocketServer, WebSocket } from 'ws';
import { Room, type Actor } from './simulation';
import { wirePlayer, playerDelta } from '../shared/snapshot';
import { CLASS_IDS } from '../shared/weapons';
import { decodeClientMessage, encodeServerMessage, MAX_CLIENT_PAYLOAD, WIRE_PROTOCOL } from '../shared/protocol';
import { MAX_HUMANS, MAX_BOTS, TICK_RATE, SNAPSHOT_RATE, type ClientMessage, type PlayerPatch, type ServerMessage } from '../shared/types';
interface Connection {
    id: string;
    binary: boolean;
    ws: WebSocket;
    room?: Room;
    actor?: Actor;
    token?: string;
    baseline: Map<string, PlayerPatch>;
    metadata: string;
    keyframeSlot: number;
    snapshot: number;
    messages: number;
    strikes: number;
    pingAt: number;
    pongAt: number;
    lastSnapshotAt: number;
    lastInputAt: number;
    lastChatAt: number;
}
export function createGameServer() {
    const rooms = new Map<string, Room>();
    const sessions = new Map<string, {
        room: Room;
        actor: Actor;
        expires: number;
        connection?: Connection;
    }>();
    const connections = new Set<Connection>();
    const stats = { tickRate: 0, tickMs: 0, peakTickMs: 0, tickP95Ms: 0, tickP99Ms: 0, totalTickMs: 0, overBudgetTicks: 0, ticks: 0, bytesOut: 0, players: 0, rooms: 0 };
    const transport = { snapshots: 0, skippedSnapshots: 0, maxSnapshotSendGapMs: 0, maxSendCallbackMs: 0, maxBufferedBytes: 0, maxMessageBytes: 0, maxInputMessageBytes: 0, maxInputArrivalGapMs: 0, maxInputQueue: 0 };
    const root = path.resolve('dist/client');
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.pathname === '/api/health') {
            res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            res.end(JSON.stringify({ ok: true, ...stats, transport, revision: process.env.RAILWAY_GIT_COMMIT_SHA, configuredTickRate: TICK_RATE, connections: connections.size, rooms: rooms.size, players: [...connections].filter(c => c.actor).length, queuedBytes: [...connections].reduce((n, c) => n + c.ws.bufferedAmount, 0) }));
            return;
        }
        if (url.pathname === '/api/connection') {
            const address = server.address();
            const port = typeof address === 'object' && address ? address.port : 3000;
            res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            res.end(JSON.stringify(connectionInfo(req.headers, port)));
            return;
        }
        if (url.pathname === '/api/rooms') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify([...rooms.values()].map(r => ({ id: r.id, players: [...r.players.values()].filter(a => !a.state.bot && a.connected).length, phase: r.round.phase, mode: r.round.mode }))));
            return;
        }
        await serveClient(req, res, root);
    });
    const socketLog = (event: string, details: Record<string, unknown>) => console.log(JSON.stringify({ event: `ws.${event}`, ...details }));
    server.on('upgrade', req => socketLog('upgrade', { requestId: req.headers['x-railway-request-id'], path: req.url }));
    const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_CLIENT_PAYLOAD, perMessageDeflate: false });
    function send(c: Connection, m: ServerMessage) { if (c.ws.readyState === WebSocket.OPEN && c.ws.bufferedAmount === 0) {
        const data = c.binary ? encodeServerMessage(m, c.actor?.state.id) : JSON.stringify(m);
        const started = performance.now();
        c.ws.send(data, () => { transport.maxSendCallbackMs = Math.max(transport.maxSendCallbackMs, +(performance.now() - started).toFixed(3)); });
        transport.maxMessageBytes = Math.max(transport.maxMessageBytes, Buffer.byteLength(data));
        transport.maxBufferedBytes = Math.max(transport.maxBufferedBytes, c.ws.bufferedAmount);
        stats.bytesOut += Buffer.byteLength(data);
    } }
    wss.on('connection', (ws, req) => {
        const connectionId = randomBytes(4).toString('hex'), openedAt = Date.now();
        let receivedMessages = 0;
        const log = (event: string, details: Record<string, unknown> = {}) => socketLog(event, { connectionId, ...details });
        log('connection', { requestId: req.headers['x-railway-request-id'] });
        ws.on('error', error => log('error', { message: error.message, code: (error as NodeJS.ErrnoException).code }));
        ws.on('close', (code, reason) => log('close', { code, reason: reason.toString(), durationMs: Date.now() - openedAt, receivedMessages }));
        if (connections.size >= 256) {
            ws.close(1013, 'Server full');
            return;
        }
        const c: Connection = { id: connectionId, binary: ws.protocol === WIRE_PROTOCOL, ws, baseline: new Map(), metadata: '', keyframeSlot: connections.size % 100, snapshot: 0, messages: 0, strikes: 0, pingAt: Date.now(), pongAt: Date.now(), lastSnapshotAt: 0, lastInputAt: 0, lastChatAt: 0 };
        connections.add(c);
        ws.on('pong', () => { c.pongAt = Date.now(); if (c.actor)
            c.actor.rtt = Math.min(1000, c.pongAt - c.pingAt); });
        ws.on('message', (data, isBinary) => {
            receivedMessages++;
            if (++c.messages > 200) {
                ws.close(1008, 'Message rate exceeded');
                return;
            }
            let m: ClientMessage;
            try {
                m = decodeClientMessage(isBinary ? (Array.isArray(data) ? Buffer.concat(data) : data) : data.toString());
            }
            catch {
                ws.close(1008, 'Invalid message');
                return;
            }
            if (!m || typeof m !== 'object')
                return;
            if (receivedMessages === 1 || m.type === 'join') log('message', { type: m.type, bytes: Buffer.byteLength(data.toString()) });
            const now = Date.now();
            if (m.type === 'ping') {
                if (Number.isFinite(m.time))
                    send(c, { type: 'pong', time: m.time, serverTime: now });
                return;
            }
            // A retry acknowledges the existing assignment, including when the first welcome was lost.
            if (m.type === 'join' && c.actor) {
                send(c, { type: 'welcome', id: c.actor.state.id, token: c.token!, room: c.room!.id, host: c.room!.host, serverTime: now });
                snapshot(c, true);
                return;
            }
            if (m.type === 'join' && !c.actor) {
                if (!CLASS_IDS.includes(m.classId) || !['blue', 'red'].includes(m.team)) {
                    log('join-rejected', { reason: 'Invalid class or team' });
                    send(c, { type: 'error', message: 'Invalid class or team. Choose a loadout and try again.' });
                    return;
                }
                let id = String(m.room ?? '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 18);
                if (m.create || !id) {
                    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
                    do { id = [...randomBytes(5)].map(n => alphabet[n % alphabet.length]).join(''); } while (rooms.has(id));
                }
                if (m.token && sessions.has(m.token)) {
                    const s = sessions.get(m.token)!;
                    if (s.room.id === id && s.expires > now) {
                        if (s.connection && s.connection !== c) {
                            s.connection.actor = undefined;
                            s.connection.ws.close(4000, 'Session resumed');
                        }
                        c.room = s.room;
                        c.actor = s.actor;
                        c.token = m.token;
                        s.actor.connected = true;
                        s.actor.queue = [];
                        s.actor.lastSeq = s.actor.state.ack;
                        s.expires = Infinity;
                        s.connection = c;
                        if (!s.room.host)
                            s.room.host = s.actor.state.id;
                        if (s.room.round.phase === 'playing')
                            s.room.spawn(s.actor, now);
                    }
                }
                if (!c.actor) {
                    if (!rooms.has(id)) {
                        if (rooms.size >= 32) {
                            send(c, { type: 'error', message: 'All rooms are busy. Try again shortly.' });
                            return;
                        }
                        rooms.set(id, new Room(id));
                    }
                    const r = rooms.get(id)!;
                    // Disconnected identities retain a reconnect grace period, but never reserve a human slot.
                    if ([...r.players.values()].filter(a => !a.state.bot && a.connected).length >= MAX_HUMANS) {
                        send(c, { type: 'error', message: 'This room is full. Join a different room.' });
                        return;
                    }
                    for (const [token, session] of sessions) {
                        if (session.room === r && !session.actor.connected && [...r.players.values()].filter(a => !a.state.bot).length >= MAX_HUMANS) {
                            r.remove(session.actor.state.id);
                            sessions.delete(token);
                        }
                    }
                    const name = String(m.name ?? 'Guest').replace(/[<>\x00-\x1f]/g, '').trim().slice(0, 16) || 'Guest';
                    c.room = r;
                    c.actor = r.add(name, m.classId, m.team);
                    c.token = randomBytes(24).toString('hex');
                    sessions.set(c.token, { room: r, actor: c.actor, expires: Infinity, connection: c });
                    r.fillBots(now);
                    r.events.push({ type: 'notice', text: `${c.actor.state.name} joined the yard` });
                }
                c.room!.lastActive = now;
                c.room!.updateLobby(now);
                log('joined', { room: c.room!.id, player: c.actor.state.id });
                send(c, { type: 'welcome', id: c.actor.state.id, token: c.token!, room: c.room!.id, host: c.room!.host, serverTime: now });
                snapshot(c, true);
                return;
            }
            const r = c.room, a = c.actor;
            if (!r || !a)
                return;
            if (m.type === 'chat' && typeof m.text === 'string' && now - c.lastChatAt >= 750) {
                const text = m.text.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 160);
                if (text) {
                    c.lastChatAt = now;
                    for (const peer of connections) if (peer.room === r && peer.actor)
                        send(peer, { type: 'chat', player: a.state.id, name: a.state.name, team: a.state.team, text });
                }
            }
            if (m.type === 'input') {
                transport.maxInputMessageBytes = Math.max(transport.maxInputMessageBytes, Array.isArray(data) ? Buffer.concat(data).byteLength : data.byteLength);
                if (c.lastInputAt) transport.maxInputArrivalGapMs = Math.max(transport.maxInputArrivalGapMs, now - c.lastInputAt);
                c.lastInputAt = now;
                if (!r.enqueue(a, m.inputs, now) && ++c.strikes > 10)
                    ws.close(1008, 'Invalid input');
                transport.maxInputQueue = Math.max(transport.maxInputQueue, a.queue.length);
            }
            if (m.type === 'sync')
                snapshot(c, true);
            if (m.type === 'profile' && typeof m.name === 'string' && r.round.phase !== 'playing') {
                const name = r.uniqueName(m.name, a.state.id);
                if (name !== a.state.name) { a.state.name = name; a.state.ready = false; r.cancelCountdown(); }
            }
            if (m.type === 'ready' && typeof m.ready === 'boolean' && ['lobby', 'countdown'].includes(r.round.phase)) {
                a.state.ready = m.ready;
                if (!m.ready) r.cancelCountdown();
                r.updateLobby(now);
            }
            if (m.type === 'team' && (m.playerId === undefined || typeof m.playerId === 'string'))
                r.moveTeam(a.state.id, m.playerId ?? a.state.id, m.team, now);
            if (m.type === 'class' && CLASS_IDS.includes(m.classId) && (m.team === undefined || ['blue', 'red'].includes(m.team))) {
                if (r.round.phase !== 'playing') {
                    // Older clients bundle team and class. New class-only requests retain host assignments,
                    // including a team change whose snapshot has not reached the choosing player yet.
                    const team = m.team ?? a.state.team;
                    if (a.state.classId !== m.classId || a.state.team !== team) {
                        a.state.ready = false;
                        r.cancelCountdown();
                    }
                    a.state.classId = m.classId;
                    a.state.team = team;
                    r.spawn(a, now);
                }
                else {
                    a.pendingClass = m.classId;
                }
            }
            if (m.type === 'configure' && r.host === a.state.id && r.round.phase !== 'playing') {
                r.resetReady();
                if (Number.isInteger(m.scoreLimit)) r.round.scoreLimit = Math.max(5, Math.min(200, m.scoreLimit!));
                if (Number.isInteger(m.duration)) r.round.duration = Math.max(60000, Math.min(1800000, m.duration!));
                if (m.mode === 'ffa' || m.mode === 'tdm')
                    r.round.mode = m.mode;
                if (['easy', 'normal', 'hard'].includes(m.difficulty ?? ''))
                    r.difficulty = m.difficulty!;
                if (Number.isInteger(m.bots))
                    r.botCount = Math.max(0, Math.min(MAX_BOTS, m.bots!));
                r.fillBots(now);
            }
            if (m.type === 'start' && r.host === a.state.id && r.round.phase === 'lobby')
                r.countdown(now, true);
        });
        ws.on('close', () => { connections.delete(c); if (c.actor) {
            c.actor.connected = false;
            c.actor.state.ready = false;
            c.actor.queue = [];
            c.actor.state.alive = false;
            c.actor.state.hp = 0;
            c.actor.state.respawnAt = Date.now() + 20000;
            if (c.token) {
                const s = sessions.get(c.token);
                if (s) {
                    s.expires = Date.now() + 20000;
                    s.connection = undefined;
                }
            }
            if (c.room?.host === c.actor.state.id)
                c.room.host = [...c.room.players.values()].find(a => !a.state.bot && a.connected)?.state.id ?? '';
            c.room?.updateLobby(Date.now());
        } });
    });
    let snapshotId = 0;
    function snapshot(c: Connection, force = false) {
        if (!c.room || !c.actor)
            return;
        if (c.ws.readyState !== WebSocket.OPEN || c.ws.bufferedAmount > 0) {
            transport.skippedSnapshots++;
            // Retain the last transmitted baseline; the next delta skips obsolete states.
            return;
        }
        const now = Date.now();
        if (c.lastSnapshotAt) transport.maxSnapshotSendGapMs = Math.max(transport.maxSnapshotSendGapMs, now - c.lastSnapshotAt);
        c.lastSnapshotAt = now;
        transport.snapshots++;
        const full = force || !c.baseline.size || snapshotId % 100 === c.keyframeSlot, patches: PlayerPatch[] = [], removed: string[] = [];
        for (const a of c.room.players.values()) {
            if (!a.connected) continue;
            const p = wirePlayer(a.state, a === c.actor);
            const patch = playerDelta(p, full ? undefined : c.baseline.get(p.id));
            if (patch) patches.push(patch);
            c.baseline.set(p.id, p);
        }
        for (const id of c.baseline.keys())
            if (!c.room.players.get(id)?.connected) {
                removed.push(id);
                c.baseline.delete(id);
            }
        const metadata = { round: c.room.round, host: c.room.host, difficulty: c.room.difficulty, bots: c.room.botCount };
        const encoded = JSON.stringify(metadata);
        send(c, { type: 'snapshot', n: snapshotId, base: full ? 0 : c.snapshot, time: Date.now(), full, players: patches, removed, ...(full || encoded !== c.metadata ? metadata : {}) });
        c.metadata = encoded;
        c.snapshot = snapshotId;
    }
    let tick = 0, lastStats = performance.now(), count = 0, total = 0, peak = 0, next = performance.now(), timer: ReturnType<typeof setTimeout>;
    let durations: number[] = [];
    function loop() {
        const begin = performance.now(), now = Date.now();
        for (const r of rooms.values())
            if ([...r.players.values()].some(a => !a.state.bot && a.connected))
                r.tick(now);
        if (tick++ % (TICK_RATE / SNAPSHOT_RATE) === 0) {
            snapshotId++;
            for (const c of connections)
                snapshot(c);
            for (const r of rooms.values()) {
                if (r.events.length) {
                    for (const c of connections)
                        if (c.room === r)
                            send(c, { type: 'events', events: r.events });
                    r.events = [];
                }
            }
        }
        const elapsed = performance.now() - begin;
        count++;
        total += elapsed;
        peak = Math.max(peak, elapsed);
        stats.ticks++;
        stats.totalTickMs += elapsed;
        if (elapsed > 1000 / TICK_RATE) stats.overBudgetTicks++;
        durations.push(elapsed);
        if (begin - lastStats >= 1000) {
            stats.tickRate = +(count * 1000 / (begin - lastStats)).toFixed(1);
            stats.tickMs = +(total / count).toFixed(3);
            stats.peakTickMs = +peak.toFixed(3);
            durations.sort((a, b) => a - b);
            stats.tickP95Ms = +durations[Math.floor((durations.length - 1) * .95)].toFixed(3);
            stats.tickP99Ms = +durations[Math.floor((durations.length - 1) * .99)].toFixed(3);
            durations = [];
            count = 0;
            total = 0;
            peak = 0;
            lastStats = begin;
            for (const c of connections) {
                c.messages = 0;
                if (now - c.pongAt > 15000) {
                    socketLog('heartbeat-timeout', { connectionId: c.id, silenceMs: now - c.pongAt });
                    c.ws.terminate();
                }
                else if (now - c.pingAt > 2000) {
                    c.pingAt = now;
                    c.ws.ping();
                }
            }
            for (const [token, s] of sessions)
                if (s.expires < now) {
                    s.room.remove(s.actor.state.id);
                    s.room.fillBots(now);
                    sessions.delete(token);
                }
            for (const [id, r] of rooms) {
                if ([...r.players.values()].some(a => !a.state.bot && a.connected))
                    r.lastActive = now;
                else if (now - r.lastActive > 30000)
                    rooms.delete(id);
            }
        }
        next += 1000 / TICK_RATE;
        if (next < performance.now() - 100)
            next = performance.now();
        timer = setTimeout(loop, Math.max(0, next - performance.now()));
    }
    timer = setTimeout(loop, 0);
    return { server, rooms, stats, close: async () => { clearTimeout(timer); for (const c of connections)
            c.ws.terminate(); await new Promise<void>(resolve => wss.close(() => resolve())); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const app = createGameServer();
    const port = Number(process.env.PORT ?? 3000);
    app.server.listen(port, '0.0.0.0', () => console.log(`Arena server http://localhost:${port} · ${TICK_RATE} Hz · WebSocket /ws`));
    for (const signal of ['SIGINT', 'SIGTERM'] as const)
        process.on(signal, () => { void app.close().then(() => process.exit(0)); });
}
