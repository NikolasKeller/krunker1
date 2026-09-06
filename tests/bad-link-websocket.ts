import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFile } from 'node:fs/promises';
import { WebSocket } from 'ws';
import { Network } from '../src/client/network';
import { LocalMotion } from '../src/client/local-motion';
import { correctedPosition, predictInput } from '../src/client/prediction';
import { neutralInput } from '../src/shared/movement';
import { decodeClientMessage, decodeServerMessage } from '../src/shared/protocol';
import { distribution, separation, uploadDelay, downloadDelay, walkingInput } from './bad-link-session';

// No browser: real production Network + WebSocket, ordered application-level
// delays in both directions, and the same render-input driver as game.ts.
const origin = new URL(process.env.GAME_URL ?? 'http://127.0.0.1:8088');
Object.assign(globalThis, { WebSocket, location: origin, sessionStorage: { getItem: () => null, setItem() {} } });
const net = new Network();
const wait = async (predicate: () => unknown) => {
    const deadline = performance.now() + 15000;
    while (!predicate()) { assert.ok(performance.now() < deadline, 'join/start timed out'); await delay(10); }
};
try {
    net.connect({ name: 'Bad link probe', room: '', create: true, classId: 'hunter', team: 'blue' });
    await wait(() => net.local && net.round);
    // This recorded movement tape uses the Sandyard west lane.
    net.send({ type: 'configure', map: 'sandyard', bots: 0, duration: 1800000 });
    await wait(() => net.players.size === 1 && net.round?.mapId === 'sandyard');
    net.send({ type: 'ready', ready: true });
    await wait(() => net.round?.phase === 'playing');
    // Walk from the normal spawn into the west lane using ordinary inputs.
    for (let i = 0; i < 30; i++) { net.input({ ...neutralInput(++net.seq), strafe: -1 }); await delay(1000 / 60); }
    for (let i = 0; i < 45; i++) { net.input(neutralInput(++net.seq)); await delay(1000 / 60); }
    await wait(() => net.local!.ack === net.seq);
    assert.ok(net.predicted!.x < -32, 'probe reached the clear lane');
    let reference = { ...net.predicted! };
    const ws = net.ws!, transmit = ws.send.bind(ws), receive = ws.onmessage!;
    const started = performance.now(), seconds = 120;
    const uploads: { at: number; data: Parameters<typeof ws.send>[0] }[] = [];
    const downloads: { at: number; event: MessageEvent }[] = [];
    let lastUpload = 0, lastDownload = 0, snapshotJump = 0, previousSnapshot = net.lastSnapshot;
    const raw: number[] = [], visible: number[] = [], errors: number[] = [], frameMs: number[] = [], rtts: number[] = [];
    let frozen = 0, stallFrames = 0, lastView = correctedPosition(net.predicted!, net.correction), lastIdeal = { ...reference };
    let maxBackward = 0, previousSequence = net.seq, sequenceGaps = 0;
    const elapsed = () => performance.now() - started;
    ws.send = data => {
        const ms = elapsed(); lastUpload = Math.max(lastUpload, ms + uploadDelay(ms));
        uploads.push({ at: lastUpload, data });
    };
    ws.onmessage = event => {
        const ms = elapsed(); lastDownload = Math.max(lastDownload, ms + downloadDelay(ms));
        downloads.push({ at: lastDownload, event });
    };
    const motion = new LocalMotion(), idealMotion = new LocalMotion();
    const idealDriver = { seq: net.seq, predicted: reference, input: (input: ReturnType<typeof neutralInput>) => predictInput(reference, input, true) };
    const firstSequence = net.seq;
    const sample = (seq: number) => {
        const input = (seq - firstSequence) <= seconds * 60 ? walkingInput(seq, (seq - firstSequence - 1) / 60) : neutralInput(seq);
        input.shotTime = net.serverNow - 350;
        return input;
    };
    let previousTime = performance.now(), nextProbe = 0;
    while (elapsed() < (seconds + 10) * 1000) {
        await delay(4);
        const time = performance.now(), ms = elapsed(), dt = Math.min(.05, (time - previousTime) / 1000);
        previousTime = time;
        while (uploads[0]?.at <= ms) {
            const { data } = uploads.shift()!;
            const message = decodeClientMessage(data as string | ArrayBuffer | ArrayBufferView);
            if (message.type === 'input') for (const input of message.inputs) { sequenceGaps += input.seq - previousSequence - 1; previousSequence = input.seq; }
            transmit(data);
        }
        while (downloads[0]?.at <= ms) {
            const { event } = downloads.shift()!;
            const before = { ...net.predicted! }, view = correctedPosition(before, net.correction);
            const message = decodeServerMessage(event.data);
            if (message.type === 'pong' && ms <= seconds * 1000) rtts.push(Date.now() - message.time);
            receive.call(ws, event);
            if (previousSnapshot !== net.lastSnapshot) {
                if (ms <= seconds * 1000) {
                    raw.push(separation(before, net.predicted!));
                    snapshotJump = Math.max(snapshotJump, separation(view, correctedPosition(net.predicted!, net.correction)));
                }
                previousSnapshot = net.lastSnapshot;
            }
        }
        if (ms >= nextProbe && ms <= seconds * 1000) { net.send({ type: 'ping', time: Date.now() }); nextProbe += 250; }
        motion.advance(dt, net, sample); idealMotion.advance(dt, idealDriver, sample);
        const applied = net.smoothCorrection(dt);
        const view = correctedPosition(motion.preview(net.predicted, sample(net.seq + 1), true)!, net.correction);
        const ideal = idealMotion.preview(reference, sample(idealDriver.seq + 1), true)!;
        if (ms <= seconds * 1000) {
            visible.push(applied); errors.push(separation(view, ideal)); frameMs.push(dt * 1000);
            const dx = ideal.x - lastIdeal.x, dz = ideal.z - lastIdeal.z, length = Math.hypot(dx, dz);
            if (length > .001) {
                maxBackward = Math.max(maxBackward, -((view.x - lastView.x) * dx + (view.z - lastView.z) * dz) / length);
                if (ms > 55000 && ms < 59000) { stallFrames++; if (separation(view, lastView) < .0001) frozen++; }
            }
        }
        lastView = view; lastIdeal = ideal;
    }
    const report = { date: new Date().toISOString(), origin: origin.origin, seconds, probeRttMs: distribution(rtts), simulationFrameMs: distribution(frameMs), simulationDeltaClampedAtMs: 50, rawCorrectionMetres: distribution(raw), visibleFrameCorrectionMetres: distribution(visible), maxSnapshotCameraJumpMetres: snapshotJump, maxBackwardFrameMetres: maxBackward, deviationFromUnimpairedClientMetres: distribution(errors), correctionsOver1cmPerSecond: raw.filter(x => x > .01).length / seconds, frozenStallFrames: frozen, stallFrames, sequenceGaps, droppedInputs: net.inputs.dropped, maxPending: net.inputs.maxPending, maxInFlight: net.inputs.maxInFlight, maxOutgoing: net.inputs.maxOutgoing, finalReferenceErrorMetres: separation(reference, net.local!) };
    console.log(JSON.stringify(report, null, 2));
    if (process.env.BAD_LINK_REPORT) await writeFile(process.env.BAD_LINK_REPORT, JSON.stringify(report, null, 2) + '\n');
    assert.equal(sequenceGaps, 0); assert.equal(frozen, 0); assert.equal(net.inputs.dropped, 0);
    assert.ok(snapshotJump < .001 && maxBackward < .001, 'no visible backward movement or snapshot jump');
    assert.ok(report.deviationFromUnimpairedClientMetres.max < .001, 'rendered movement matches the unimpaired local driver');
    assert.ok(report.finalReferenceErrorMetres < .001, 'server recovers the full movement path');
} finally { net.disconnect(); }
