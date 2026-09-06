import { writeFile, mkdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { decodeServerMessage, encodeClientMessage, WIRE_PROTOCOL } from '../../src/shared/protocol';
import type { ClientMessage, PlayerState } from '../../src/shared/types';
import { arrivalReport, distribution, type Arrival } from './metrics';
import { sampleTcp } from './tcp-info';

const origin = process.env.GAME_URL ?? 'https://krunker1-production.up.railway.app';
const seconds = Number(process.env.PROBE_SECONDS ?? 120);
if (!Number.isFinite(seconds) || seconds < 5 || seconds > 3600) throw Error('PROBE_SECONDS must be 5..3600');
const reportPath = process.env.PROBE_REPORT ?? 'artifacts/transport/live-websocket.json';
const getHealth = async () => {
    const response = await fetch(origin + '/api/health', { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw Error(`health: ${response.status}`);
    return { data: await response.json(), edge: response.headers.get('x-railway-edge') };
};
const before = await getHealth();
const rows: Arrival[] = [], rtts: number[] = [], errors: string[] = [];
const players = new Map<string, PlayerState>();
let n = 0, baselineErrors = 0, active = false, joined = false, started = 0;
const ws = new WebSocket(origin.replace(/^http/, 'ws') + '/ws', WIRE_PROTOCOL, { handshakeTimeout: 30000 });
const send = (m: ClientMessage) => { if (ws.readyState === WebSocket.OPEN) ws.send(encodeClientMessage(m)); };
ws.on('error', e => errors.push(e.message));
ws.on('close', code => { if (active) errors.push(`closed during capture: ${code}`); });
ws.on('open', () => send({ type: 'join', create: true, name: 'Transport probe', room: '', classId: 'hunter', team: 'blue' }));
ws.on('message', (raw, binary) => {
    try {
        const data = Array.isArray(raw) ? Buffer.concat(raw) : raw;
        const m = decodeServerMessage(binary ? data : data.toString());
        if (m.type === 'welcome') {
            joined = true;
            // Only this newly created diagnostic room is changed.
            send({ type: 'configure', bots: 7, duration: 1800000, scoreLimit: 200 });
            send({ type: 'start' });
        }
        if (m.type === 'error') errors.push(m.message);
        if (m.type === 'pong' && active) rtts.push(Date.now() - m.time);
        if (m.type !== 'snapshot') return;
        const applied = m.n > n && (m.full || m.base === n);
        if (active) rows.push({ n: m.n, sent: m.time, arrived: performance.now(), bytes: data.byteLength, applied });
        if (!applied) { baselineErrors++; send({ type: 'sync' }); return; }
        n = m.n;
        if (m.full) players.clear();
        for (const patch of m.players) players.set(patch.id, { ...players.get(patch.id), ...patch } as PlayerState);
        for (const id of m.removed) players.delete(id);
        for (const p of players.values()) if (![p.x, p.y, p.z, p.hp].every(Number.isFinite)) errors.push('nonfinite replica');
    } catch (e) { errors.push(String(e)); }
});
let heartbeat: ReturnType<typeof setInterval> | undefined;
const eventLoop = monitorEventLoopDelay({ resolution: 10 });
let tcp: ReturnType<typeof sampleTcp> | undefined;
try {
    const deadline = performance.now() + 35000;
    while ((!joined || !n) && performance.now() < deadline && !errors.length) await delay(20);
    if (!joined || !n || errors.length) throw Error('join failed: ' + errors.join('; '));
    await delay(5000);
    tcp = sampleTcp(ws);
    active = true; started = performance.now(); eventLoop.enable();
    heartbeat = setInterval(() => send({ type: 'ping', time: Date.now() }), 250);
    await delay(seconds * 1000);
    active = false; eventLoop.disable();
    const ended = performance.now(), after = await getHealth();
    const { samples: tcpSamples, ...tcpSummary } = tcp.report(rows, started, ended);
    const arrivalsFile = basename(reportPath, '.json') + '.arrivals.ndjson';
    const tcpFile = basename(reportPath, '.json') + '.tcp.ndjson';
    const report = {
        date: new Date().toISOString(), origin, nodeVersion: process.version,
        vantage: process.env.PROBE_VANTAGE ?? 'workstation; not inside Railway or the affected player network',
        durationSeconds: (ended - started) / 1000, protocol: WIRE_PROTOCOL,
        revision: before.data.revision, revisionAfter: after.data.revision,
        attribution: 'unknown: arrival bursts do not prove TCP retransmission; no parallel deployed UDP channel or packet capture',
        summary: arrivalReport(rows, started, ended), rttMs: distribution(rtts), baselineErrors, errors,
        eventLoopDelayMs: { p99: eventLoop.percentile(99) / 1e6, max: eventLoop.max / 1e6 },
        tcp: { ...tcpSummary, samplesFile: tcpFile },
        healthBefore: before, healthAfter: after,
        // Monotonic receive times relative to this capture; server times remain epoch milliseconds.
        arrivalsFile,
    };
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(join(dirname(reportPath), arrivalsFile), rows.map(r => JSON.stringify({ ...r, arrived: r.arrived - started })).join('\n') + '\n');
    await writeFile(join(dirname(reportPath), tcpFile), tcpSamples.map(s => JSON.stringify(s)).join('\n') + '\n');
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ ...report, healthBefore: undefined, healthAfter: undefined }, null, 2));
    if (errors.length || baselineErrors || before.data.revision !== after.data.revision || rows.length < seconds * 10) process.exitCode = 1;
} finally {
    active = false; tcp?.stop(); eventLoop.disable(); clearInterval(heartbeat); ws.terminate();
}
