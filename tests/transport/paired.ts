// Standalone diagnostic sidecar. Never imported by the production server/client.
// It reads a private game room's WS state, reconstructs each delta, then sends
// identical INDEPENDENT keyframes through WS and an unordered, unreliable DC.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket, WebSocketServer } from 'ws';
import { RTCPeerConnection, type RTCDataChannel } from 'werift';
import { createGameServer } from '../../src/server/index';
import { decodeServerMessage, encodeServerMessage, encodeClientMessage, WIRE_PROTOCOL } from '../../src/shared/protocol';
import type { PlayerPatch } from '../../src/shared/types';
import { arrivalReport, IndependentReplica, type Arrival } from './metrics';

const iceServers = JSON.parse(process.env.PROBE_ICE_SERVERS ?? '[]');
for (const server of iceServers) for (const url of [server.urls].flat()) {
    assert.ok(typeof url === 'string' && /^(stun|turn):/.test(url) && !/transport=(?!udp(?:&|$))/.test(url),
        'This off-TCP experiment accepts only STUN or UDP TURN; TLS/TCP relays would confound the comparison');
}
const peer = () => new RTCPeerConnection({ iceServers, iceAdditionalHostAddresses: ['127.0.0.1'], iceUseTcp: false });
// Werift 0.24.4 overwrites the unordered bit in its DCEP channelType when
// maxRetransmits is set. Explicit negotiation configures BOTH ends correctly
// and avoids treating its silently ordered responder as the requested test.
const channelOptions = { ordered: false, maxRetransmits: 0, negotiated: true, id: 0 } as const;
const withoutCandidates = (description: { type: 'offer' | 'answer' | 'pranswer'; sdp: string }) =>
    ({ ...description, sdp: description.sdp.replace(/^a=candidate:.*\r?\n/gm, '') });
const waitFor = async (fn: () => boolean, ms: number) => {
    const deadline = performance.now() + ms;
    while (!fn() && performance.now() < deadline) await delay(20);
    return fn();
};
async function listen(server: http.Server, port = 0, host = '127.0.0.1') {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    return address.port;
}

async function createProbe(gameUrl: string, token?: string) {
    const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
    const wss = new WebSocketServer({ noServer: true, maxPayload: 65536, perMessageDeflate: false });
    const cleanup = new Set<() => Promise<void>>();
    server.on('upgrade', (req, socket, head) => {
        if (req.url !== '/probe' || wss.clients.size >= 1 || (token && req.headers.authorization !== `Bearer ${token}`)) {
            socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
        }
        wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
    });
    wss.on('connection', ws => {
        let pc: RTCPeerConnection | undefined, dc: RTCDataChannel | undefined, source: WebSocket | undefined;
        let last = 0, stopped = false;
        const players = new Map<string, PlayerPatch>();
        const send = (m: object) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };
        const stop = async () => {
            if (stopped) return; stopped = true;
            clearTimeout(lifetime); source?.terminate(); ws.terminate(); await pc?.close(); cleanup.delete(stop);
        };
        const lifetime = setTimeout(() => void stop(), 10 * 60 * 1000);
        cleanup.add(stop);
        ws.on('close', () => void stop()); ws.on('error', () => void stop());
        ws.on('message', (raw, binary) => {
            void (async () => {
                if (binary) throw Error('expected signaling JSON');
                const m = JSON.parse(raw.toString());
                if (m.type === 'offer' && !pc) {
                    assert.deepEqual(m.channel, channelOptions, 'both peers must use identical channel settings');
                    pc = peer();
                    dc = pc.createDataChannel('state-probe', channelOptions);
                    await pc.setRemoteDescription(m.description);
                    await pc.setLocalDescription(await pc.createAnswer());
                    if (!stopped) send({ type: 'answer', description: pc.localDescription });
                }
                if (m.type === 'start' && !source) {
                    source = new WebSocket(gameUrl.replace(/^http/, 'ws') + '/ws', WIRE_PROTOCOL);
                    source.on('error', e => send({ type: 'error', message: e.message }));
                    source.on('close', () => { if (!stopped) send({ type: 'error', message: 'source closed' }); });
                    source.on('open', () => source!.send(encodeClientMessage({ type: 'join', create: true, name: 'Paired probe', room: '', classId: 'hunter', team: 'blue' })));
                    source.on('message', (raw, binary) => {
                        try {
                            const data = Array.isArray(raw) ? Buffer.concat(raw) : raw;
                            const message = decodeServerMessage(binary ? data : data.toString());
                            if (message.type === 'welcome') {
                                source!.send(encodeClientMessage({ type: 'configure', bots: 7, scoreLimit: 200, duration: 1800000 }));
                                source!.send(encodeClientMessage({ type: 'start' }));
                            }
                            if (message.type !== 'snapshot') return;
                            if (!message.full && message.base !== last) throw Error('source baseline missing');
                            last = message.n;
                            if (message.full) players.clear();
                            for (const patch of message.players) players.set(patch.id, { ...players.get(patch.id), ...patch });
                            for (const id of message.removed) players.delete(id);
                            const packet = Buffer.from(encodeServerMessage({ ...message, full: true, base: 0, players: [...players.values()], removed: [] }));
                            if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 65536) ws.send(packet);
                            if (dc?.readyState === 'open' && dc.bufferedAmount < 65536) dc.send(packet);
                        } catch (e) { send({ type: 'error', message: String(e) }); }
                    });
                }
            })().catch(e => send({ type: 'error', message: String(e) }));
        });
    });
    return { server, close: async () => {
        await Promise.all([...cleanup].map(fn => fn()));
        await new Promise<void>(resolve => wss.close(() => resolve()));
        await new Promise<void>(resolve => server.close(() => resolve()));
    } };
}

async function run() {
    if (process.argv.includes('--serve')) {
        assert.ok(process.env.PROBE_TOKEN, 'PROBE_TOKEN is required for a publicly bound diagnostic server');
        const probe = await createProbe(process.env.GAME_URL ?? 'http://127.0.0.1:3000', process.env.PROBE_TOKEN);
        const port = await listen(probe.server, Number(process.env.PORT ?? 8081), '0.0.0.0');
        console.log(`Diagnostic /probe listening on ${port}; production game transport is unchanged`);
        for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void probe.close());
        return;
    }
    const seconds = Number(process.env.PROBE_SECONDS ?? 30);
    assert.ok(Number.isFinite(seconds) && seconds >= 5 && seconds <= 480);
    const local = !process.env.PROBE_URL;
    const game = local ? createGameServer() : undefined;
    const gamePort = game ? await listen(game.server) : undefined;
    const probe = local ? await createProbe(`http://127.0.0.1:${gamePort}`) : undefined;
    const probePort = probe ? await listen(probe.server) : undefined;
    const url = process.env.PROBE_URL ?? `ws://127.0.0.1:${probePort}/probe`;
    const blocked = process.env.PROBE_BLOCK_UDP === '1';
    const ws = new WebSocket(url, { headers: process.env.PROBE_TOKEN ? { authorization: `Bearer ${process.env.PROBE_TOKEN}` } : {}, handshakeTimeout: 10000 });
    const pc = peer(), dc = pc.createDataChannel('state-probe', channelOptions);
    const rows = { websocket: [] as Arrival[], webrtc: [] as Arrival[] };
    const replicas = { websocket: new IndependentReplica(), webrtc: new IndependentReplica() }, errors: string[] = [];
    const packets = new Map<number, { websocket?: Buffer; webrtc?: Buffer }>();
    let active = false, compared = 0, mismatches = 0, closedAt: number | undefined;
    const receive = (kind: keyof typeof rows, packet: Buffer) => {
        try {
            const m = decodeServerMessage(packet);
            if (m.type !== 'snapshot' || !m.full) throw Error('expected independent snapshot');
            const applied = replicas[kind].apply(m);
            if (active) {
                rows[kind].push({ n: m.n, sent: m.time, arrived: performance.now(), bytes: packet.length, applied });
                const pair = packets.get(m.n) ?? {}; pair[kind] = packet; packets.set(m.n, pair);
                if (pair.websocket && pair.webrtc) { compared++; if (!pair.websocket.equals(pair.webrtc)) mismatches++; packets.delete(m.n); }
                for (const n of packets.keys()) if (n < m.n - 200) packets.delete(n);
            }
        } catch (e) { errors.push(String(e)); }
    };
    dc.onMessage.subscribe(data => receive('webrtc', Buffer.from(data)));
    ws.on('error', e => errors.push(e.message));
    ws.on('close', () => { if (active) errors.push('WebSocket closed during capture'); });
    ws.on('message', (data, binary) => {
        if (binary) { receive('websocket', Buffer.from(data as Buffer)); return; }
        void (async () => {
            const m = JSON.parse(data.toString());
            if (m.type === 'answer') await pc.setRemoteDescription(blocked ? withoutCandidates(m.description) : m.description);
            if (m.type === 'error') errors.push(m.message);
        })().catch(e => errors.push(String(e)));
    });
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    try {
        assert.ok(await waitFor(() => ws.readyState === WebSocket.OPEN || errors.length > 0, 10000), 'signaling connection timeout');
        assert.deepEqual(errors, []);
        await pc.setLocalDescription(await pc.createOffer());
        // Remove candidates on both sides to exercise failed ICE negotiation
        // without privileges to change the host firewall.
        ws.send(JSON.stringify({ type: 'offer', channel: channelOptions, description: blocked ? withoutCandidates(pc.localDescription!) : pc.localDescription }));
        const connected = await waitFor(() => dc.readyState === 'open', blocked ? 1000 : 20000);
        // Keep the WS state feed alive even when UDP cannot establish. This is
        // diagnostic fallback only; no gameplay transport has been migrated.
        ws.send(JSON.stringify({ type: 'start' }));
        assert.ok(await waitFor(() => replicas.websocket.n > 0 && (!connected || replicas.webrtc.n > 0), 10000), 'source did not start');
        await delay(4000);
        const selected = pc.iceTransports.flatMap(t => {
            const pair = t.connection.nominated;
            return pair ? [{ protocol: pair.localCandidate.transport, localType: pair.localCandidate.type, remoteType: pair.remoteCandidate.type }] : [];
        });
        const started = performance.now(); active = true;
        if (process.env.PROBE_CLOSE_UDP === '1' && connected) closeTimer = setTimeout(() => { closedAt = performance.now(); void pc.close(); }, seconds * 500);
        await delay(seconds * 1000); active = false;
        const ended = performance.now();
        const path = process.env.PROBE_REPORT ?? 'artifacts/transport/paired-local.json';
        const arrivalsFile = basename(path, '.json') + '.arrivals.ndjson';
        const report = { date: new Date().toISOString(), nodeVersion: process.version, url, local, seconds,
            evidence: local ? 'loopback diagnostic only, no link impairment; not deployment or poor-link acceptance evidence' : 'paired sidecar capture; inspect route, ICE candidates and source cadence before attribution',
            payload: 'identical full reconstructed snapshots; larger than production delta snapshots',
            connected, ordered: dc.ordered, maxRetransmits: dc.maxRetransmits, selected, blocked, closedAtMs: closedAt ? closedAt - started : null,
            websocket: arrivalReport(rows.websocket, started, ended), webrtc: arrivalReport(rows.webrtc, started, ended), compared, mismatches, errors,
            arrivalsFile };
        await mkdir(dirname(path), { recursive: true });
        const arrivals = Object.entries(rows).flatMap(([transport, events]) => events.map(r => ({ ...r, transport, arrived: r.arrived - started }))).sort((a, b) => a.arrived - b.arrived);
        await writeFile(join(dirname(path), arrivalsFile), arrivals.map(r => JSON.stringify(r)).join('\n') + '\n');
        await writeFile(path, JSON.stringify(report, null, 2) + '\n');
        console.log(JSON.stringify(report, null, 2));
        assert.deepEqual(errors, []); assert.equal(mismatches, 0);
        assert.ok(rows.websocket.length > seconds * 10, 'WS feed remains usable');
        if (!blocked) { assert.ok(connected, 'UDP unavailable: capture retained, not an improvement result'); assert.ok(compared > seconds * (closedAt ? 5 : 10)); }
        else assert.equal(connected, false, 'candidate suppression must prevent UDP establishment');
        if (closedAt) assert.ok(rows.websocket.some(r => r.arrived > closedAt! + 1000), 'WS survives DC close');
    } finally {
        active = false; clearTimeout(closeTimer); ws.terminate(); await pc.close(); await probe?.close(); await game?.close();
    }
}
await run();
