import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFile } from 'node:fs/promises';
import { WebSocket } from 'ws';
import { Network } from '../src/client/network';
import { neutralInput } from '../src/shared/movement';
import { STEP } from '../src/shared/types';

// Run against an isolated production HTTP/WS port, locally or inside Railway.
// The real client owns prediction, input pacing and acknowledgement backpressure.
const origin = new URL(process.env.GAME_URL ?? 'http://127.0.0.1:8080');
Object.assign(globalThis, { WebSocket, location: origin, sessionStorage: { getItem: () => null, setItem: () => {} } });
const wait = async (predicate: () => unknown) => {
    const deadline = Date.now() + 15000;
    while (!predicate()) { assert.ok(Date.now() < deadline, 'client joins and starts'); await delay(10); }
};
const stats = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return { p50: sorted[Math.floor((sorted.length - 1) * .5)] ?? 0, p95: sorted[Math.floor((sorted.length - 1) * .95)] ?? 0, max: sorted.at(-1) ?? 0 };
};
const report = [];
for (const stallMs of [1000, 2000]) {
    const net = new Network();
    try {
        net.connect({ name: 'Movement probe', room: '', create: true, classId: 'hunter', team: 'blue' });
        await wait(() => net.local && net.round);
        net.send({ type: 'configure', bots: 0 });
        await wait(() => net.players.size === 1);
        net.send({ type: 'ready', ready: true });
        await wait(() => net.round?.phase === 'playing');
        const ws = net.ws!, transmit = ws.send.bind(ws), receive = ws.onmessage!;
        let stalled = true, cameraJump = 0, corrections = 0;
        const rawCorrections: number[] = [];
        const uploads: Parameters<typeof ws.send>[0][] = [], downloads: MessageEvent[] = [];
        ws.send = data => { if (stalled) uploads.push(data); else transmit(data); };
        const deliver = (event: MessageEvent) => {
            const before = { ...net.predicted! }, view = { x: before.x + net.correction.x, y: before.y + net.correction.y, z: before.z + net.correction.z };
            const snapshot = net.lastSnapshot;
            receive.call(ws, event);
            cameraJump = Math.max(cameraJump, Math.hypot(view.x - net.predicted!.x - net.correction.x, view.y - net.predicted!.y - net.correction.y, view.z - net.predicted!.z - net.correction.z));
            const error = Math.hypot(before.x - net.predicted!.x, before.y - net.predicted!.y, before.z - net.predicted!.z);
            if (net.lastSnapshot !== snapshot) rawCorrections.push(error);
            if (error > .01) corrections++;
        };
        ws.onmessage = event => { if (stalled) downloads.push(event); else deliver(event); };
        const steps: number[] = [], visibleSpeeds: number[] = [];
        let last = performance.now(), elapsed = 0, accumulator = 0;
        while (elapsed < stallMs + 6000) {
            await delay(4);
            const now = performance.now(), dt = Math.min(.05, (now - last) / 1000); last = now; elapsed += dt * 1000;
            accumulator += dt;
            while (accumulator >= STEP) {
                accumulator -= STEP;
                const before = { ...net.predicted! };
                net.input({ ...neutralInput(++net.seq), forward: stalled ? 1 : 0 });
                if (stalled) steps.push(Math.hypot(before.x - net.predicted!.x, before.z - net.predicted!.z));
            }
            if (stalled && elapsed >= stallMs) {
                stalled = false;
                for (const data of uploads) transmit(data);
                for (const event of downloads) deliver(event);
            }
            visibleSpeeds.push(net.smoothCorrection(dt) / dt);
        }
        const row = { stallMs, origin: origin.origin, simulationSteps: steps.length, frozenSteps: steps.filter(d => d < .001).length, movedMetres: steps.reduce((a, b) => a + b, 0), rawCorrectionMetres: stats(rawCorrections), correctionsOver1cm: corrections, maxSnapshotCameraJumpMetres: cameraJump, visibleCorrectionMetresPerSecond: stats(visibleSpeeds), remainingVisualCorrectionMetres: Math.hypot(net.correction.x, net.correction.y, net.correction.z), maxInFlight: net.inputs.maxInFlight, maxOutgoing: net.inputs.maxOutgoing };
        report.push(row);
        console.log(JSON.stringify(row));
        assert.equal(row.frozenSteps, 0, 'actual WebSocket backpressure cannot pause local walking');
        assert.ok(row.movedMetres > stallMs / 1000 * 9);
        assert.ok(cameraJump < 1e-8, 'no snapshot camera teleport');
        assert.ok(row.visibleCorrectionMetresPerSecond.max <= 6 + 1e-9, 'at most 10 cm of correction per 60 FPS frame');
        assert.ok(row.remainingVisualCorrectionMetres < .001, 'recovery converges');
        assert.ok(row.maxInFlight <= 30 && row.maxOutgoing <= 12, 'sender bounds remain intact');
    } finally { net.disconnect(); }
}
if (process.env.MOVEMENT_WS_REPORT) await writeFile(process.env.MOVEMENT_WS_REPORT, JSON.stringify(report, null, 2) + '\n');
