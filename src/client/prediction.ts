import { clipPlayerMotion } from '../shared/collision';
import { move, moveState } from '../shared/movement';
import { CLASSES } from '../shared/weapons';
import type { Input, MoveState, PlayerState, Vec3 } from '../shared/types';

// Prediction is a local simulation, not a transmission queue. Keep enough replay
// history for six seconds of stalls, independently of the 12 unsent / 30
// in-flight transport limits. Longer stalls preserve movement until ACKs catch up.
export const MAX_PREDICTION_INPUTS = 360;
const movementFields = Object.keys(moveState()) as (keyof MoveState)[];
export class PredictionHistory {
    pending: Input[] = [];
    private evictedThrough = 0;
    add(input: Input) {
        this.pending.push(input);
        if (this.pending.length > MAX_PREDICTION_INPUTS) {
            const evicted = this.pending.splice(0, this.pending.length - MAX_PREDICTION_INPUTS);
            this.evictedThrough = evicted.at(-1)!.seq;
        }
    }
    reconcile(authoritative: PlayerState, playing: boolean, previous?: PlayerState) {
        // An upload-only outage can outlast the watchdog while snapshots still
        // arrive. A partial replay from an older ACK would erase local progress
        // every snapshot. Keep moving until authority reaches retained history;
        // still apply health, death, round and life changes immediately.
        if (playing && previous?.alive && authoritative.alive && previous.life === authoritative.life && authoritative.ack < this.evictedThrough) {
            return { ...authoritative, ...Object.fromEntries(movementFields.map(key => [key, previous[key]])), yaw: previous.yaw, pitch: previous.pitch };
        }
        const result = reconcile(authoritative, this.pending, playing);
        this.pending = result.remaining;
        return result.predicted;
    }
    clear() { this.pending = []; this.evictedThrough = 0; }
}

// Ordinary errors settle within a few frames. A multi-second outage can lose
// metres of server movement; never turn that into a one-frame camera teleport.
export const MAX_CORRECTION_SPEED = 6;
export function smoothCorrection(correction: Vec3, dt: number) {
    const length = Math.hypot(correction.x, correction.y, correction.z);
    if (!length) return 0;
    const distance = Math.min(length * (1 - Math.exp(-18 * dt)), MAX_CORRECTION_SPEED * dt);
    const scale = 1 - distance / length;
    correction.x *= scale; correction.y *= scale; correction.z *= scale;
    return distance;
}

// Preview the fractional fixed step without changing replay state or generating
// a packet. This also responds on render frames between the 60 Hz physics steps.
export function previewInput(p: PlayerState | undefined, i: Input, playing: boolean, fraction: number) {
    if (!p) return undefined;
    const next = { ...p };
    predictInput(next, i, playing);
    const t = Math.max(0, Math.min(1, fraction));
    return { ...p, ...clipPlayerMotion(p, { x: p.x + (next.x - p.x) * t, y: p.y + (next.y - p.y) * t, z: p.z + (next.z - p.z) * t }, p.slide > 0 ? 1.26 : undefined) };
}
export function predictInput(p: PlayerState, i: Input, playing: boolean) {
    if (!p.alive || !playing || (i.life !== undefined && i.life !== p.life))
        return;
    move(p, i, CLASSES[p.classId].speed * (i.slot === 3 ? 1.16 : 1));
    p.yaw = i.yaw;
    p.pitch = i.pitch;
}
export function reconcile(authoritative: PlayerState, pending: Input[], playing: boolean) {
    const remaining = pending.filter(i => i.seq > authoritative.ack), predicted = { ...authoritative };
    for (const input of remaining)
        predictInput(predicted, input, playing);
    return { predicted, remaining };
}

export function correctedPosition(p: PlayerState, correction: Vec3) {
    return clipPlayerMotion(p, { x: p.x + correction.x, y: p.y + correction.y, z: p.z + correction.z }, p.slide > 0 ? 1.26 : undefined);
}
