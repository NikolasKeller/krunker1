import { Network } from '../src/client/network';
import { correctedPosition, predictInput, previewInput } from '../src/client/prediction';
import { Room } from './sandyard-room';
import { moveState, neutralInput } from '../src/shared/movement';
import { decodeClientMessage, encodeServerMessage, wireInput } from '../src/shared/protocol';
import { STEP, type ClientMessage, type PlayerState, type ServerMessage, type Vec3 } from '../src/shared/types';

export const distribution = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    const at = (p: number) => sorted[Math.floor((sorted.length - 1) * p)] ?? 0;
    return { p50: at(.5), p95: at(.95), p99: at(.99), max: sorted.at(-1) ?? 0 };
};
export const separation = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

// Ordered delivery (TCP head-of-line blocking), 175 ms each way, recurring
// one-second stalls, two-second tails, and an explicit four-second outage.
// Report the *delivered* probe RTT distribution, not the requested delays.
export function uploadDelay(ms: number, blackout = true, calibrated = false) {
    let delay = 175;
    const phase = ms % 6000;
    const regularEnd = calibrated ? 2771 : 3000;
    if (phase >= 2000 && phase < regularEnd) delay += regularEnd - phase;
    const tail = ms % 30000;
    const tailEnd = calibrated ? 15808 : 16000;
    if (tail >= 14000 && tail < tailEnd) delay = Math.max(delay, 175 + tailEnd - tail);
    if (blackout && ms >= 55000 && ms < 59000) delay = Math.max(delay, 59000 - ms);
    return delay;
}
export function downloadDelay(ms: number, blackout = true) {
    return blackout && ms >= 55000 && ms < 59000 ? Math.max(175, 59000 - ms) : 175;
}
export function walkingInput(seq: number, seconds: number) {
    // Run along the clear east lane, turning before the map boundary. Aim moves
    // independently; transform controls so the walking route stays in the lane.
    const direction = Math.floor(seconds / 4) % 2 ? -1 : 1, yaw = Math.sin(seconds * 1.7) * 2;
    return wireInput({ ...neutralInput(seq), forward: direction * Math.cos(yaw), strafe: direction * Math.sin(yaw), yaw, pitch: Math.sin(seconds * 2) * .8,
        jump: seconds % 3 < .1, slide: seconds % 3 > 2.5, shotTime: seconds * 1000 - 350 });
}

export class SessionSocket {
    static OPEN = 1;
    readyState = 1;
    bufferedAmount = 0;
    onmessage?: (event: { data: string | Uint8Array }) => void;
    sent: ClientMessage[] = [];
    send(data: string | Uint8Array) { this.sent.push(decodeClientMessage(data)); }
    close() { this.readyState = 3; }
}

export function runBadLinkSession(net: Network, socket: SessionSocket, renderHz = 144, mode: 'hidden' | 'blocked' | 'upload-only' = 'hidden', calibrated = false) {
    const seconds = 120, room = new Room('BADLINK'); room.botCount = 0;
    const actor = room.add('Walker', 'hunter', 'blue'); room.start(0);
    Object.assign(actor.state, moveState(34, 0, 22)); actor.lastInputAt = 0;
    let reference: PlayerState = { ...actor.state }, tick = 0, snapshot = 0, accumulator = 0;
    const uploads: { at: number; message: ClientMessage }[] = [], downloads: { at: number; message: ServerMessage }[] = [];
    const raw: number[] = [], snapshotJumps: number[] = [], frameCorrections: number[] = [], visualErrors: number[] = [], backward: number[] = [];
    const rtts: number[] = [], inputsReceived: number[] = [];
    let previous: Vec3 = { ...reference }, previousReference: Vec3 = { ...reference };
    let frozenStallFrames = 0, stallFrames = 0, lastUpload = 0, lastDownload = 0;
    const upDelay = (ms: number) => uploadDelay(ms, !calibrated, calibrated);
    const downDelay = (ms: number) => downloadDelay(ms, !calibrated && mode !== 'upload-only');
    const view = () => correctedPosition(net.predicted!, net.correction);
    const deliver = (message: ServerMessage) => {
        const before = net.predicted && { ...net.predicted }, beforeView = before && view();
        socket.onmessage?.({ data: encodeServerMessage(message, actor.state.id) });
        if (before && message.type === 'snapshot' && tick <= seconds * 60) {
            raw.push(separation(before, net.predicted!));
            snapshotJumps.push(separation(beforeView!, view()));
        }
    };
    const state = (): ServerMessage => ({ type: 'snapshot', n: ++snapshot, base: 0, full: true, time: tick * STEP * 1000, players: [{ ...actor.state }], removed: [], round: { ...room.round } });
    deliver({ type: 'welcome', id: actor.state.id, room: room.id, host: actor.state.id, token: 'session', serverTime: Date.now() });
    deliver(state());
    // Independent 250 ms probe, with FIFO delivery in both directions.
    let probeUp = 0, probeDown = 0;
    for (let ms = 0; ms < seconds * 1000; ms += 250) {
        probeUp = Math.max(probeUp, ms + upDelay(ms));
        probeDown = Math.max(probeDown, probeUp + downDelay(probeUp));
        rtts.push(probeDown - ms);
    }
    for (let frame = 1; frame <= (seconds + 10) * renderHz; frame++) {
        accumulator += 1 / renderHz;
        while (accumulator + 1e-12 >= STEP) {
            accumulator = Math.max(0, accumulator - STEP); tick++;
            const ms = tick * STEP * 1000;
            socket.bufferedAmount = mode === 'blocked' && upDelay(ms) > 175 ? 100 : 0;
            const input = tick <= seconds * 60 ? walkingInput(++net.seq, (tick - 1) * STEP) : neutralInput(++net.seq);
            net.input(input); predictInput(reference, input, true);
            net.inputs.flush(socket, ms);
            for (const message of socket.sent.splice(0)) {
                lastUpload = Math.max(lastUpload, ms + upDelay(ms));
                uploads.push({ at: lastUpload, message });
            }
            while (uploads[0]?.at <= ms + 1e-8) {
                const { message } = uploads.shift()!;
                if (message.type === 'input') {
                    inputsReceived.push(...message.inputs.map(i => i.seq));
                    if (!room.enqueue(actor, message.inputs, ms)) throw Error('valid input rejected');
                }
            }
            room.tick(ms);
            if (tick % 3 === 0) {
                lastDownload = Math.max(lastDownload, ms + downDelay(ms));
                downloads.push({ at: lastDownload, message: state() });
            }
            while (downloads[0]?.at <= ms + 1e-8) deliver(downloads.shift()!.message);
        }
        const correction = net.smoothCorrection(1 / renderHz);
        const input = tick < seconds * 60 ? walkingInput(net.seq + 1, tick * STEP) : neutralInput(net.seq + 1);
        const rendered = correctedPosition(previewInput(net.predicted, input, true, accumulator / STEP)!, net.correction);
        const ideal = previewInput(reference, input, true, accumulator / STEP)!;
        if (frame <= seconds * renderHz) {
            frameCorrections.push(correction); visualErrors.push(separation(rendered, ideal));
            const dx = ideal.x - previousReference.x, dz = ideal.z - previousReference.z, length = Math.hypot(dx, dz);
            if (length > .001) backward.push(Math.max(0, -((rendered.x - previous.x) * dx + (rendered.z - previous.z) * dz) / length));
            if (frame / renderHz > 55 && frame / renderHz < 59 && length > .001) {
                stallFrames++; if (Math.hypot(rendered.x - previous.x, rendered.z - previous.z) < .0001) frozenStallFrames++;
            }
        }
        previous = rendered; previousReference = ideal;
    }
    let sequenceGaps = 0;
    for (let i = 1; i < inputsReceived.length; i++) sequenceGaps += inputsReceived[i] - inputsReceived[i - 1] - 1;
    return { seconds, renderHz, mode, profile: calibrated ? 'matched quantiles' : 'four-second blackout stress', probeRttMs: distribution(rtts), rawCorrectionMetres: distribution(raw), snapshotCameraJumpMetres: distribution(snapshotJumps), frameCorrectionMetres: distribution(frameCorrections), deviationFromUnimpairedClientMetres: distribution(visualErrors), maxBackwardFrameMetres: Math.max(0, ...backward), correctionsOver1cmPerSecond: raw.filter(x => x > .01).length / seconds, frozenStallFrames, stallFrames, sequenceGaps, dropped: net.inputs.dropped, maxPending: net.inputs.maxPending, maxInFlight: net.inputs.maxInFlight, maxOutgoing: net.inputs.maxOutgoing, finalAuthorityErrorMetres: separation(net.predicted!, actor.state), finalReferenceErrorMetres: separation(reference, actor.state) };
}
