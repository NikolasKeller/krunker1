import { angleLerp, clamp, lerp } from '../shared/math';
import { clipPlayerMotion } from '../shared/collision';
import { INTERPOLATION_MS, MAX_INTERPOLATION_DELAY_MS, type PlayerState, type Vec3 } from '../shared/types';
import { MAX_SPEED } from '../shared/movement';
export interface RemoteFrame { time: number; players: Map<string, PlayerState> }
export const MAX_EXTRAPOLATION_MS = 1250;
export const MAX_EXTRAPOLATION_METRES = 32;
export const MAX_JITTER_BUFFER_MS = 2100;
export const REMOTE_CORRECTION_SPEED = 3;

class Samples {
    private values: number[] = [];
    private cursor = 0;
    count = 0;
    max = 0;
    add(value: number) {
        this.max = Math.max(this.max, value); this.count++;
        this.values[this.cursor++ % 24000] = value;
    }
    get summary() {
        const sorted = [...this.values].sort((a, b) => a - b);
        return { samples: this.count, retained: sorted.length, p50: sorted[Math.floor((sorted.length - 1) * .5)] ?? 0, p95: sorted[Math.floor((sorted.length - 1) * .95)] ?? 0, max: this.max };
    }
}

export class RemoteInterpolation {
    reserve = INTERPOLATION_MS;
    private arrivals: { server: number; local: number }[] = [];
    private lastGrowth = 0;
    private lastNow?: number;
    private cursor?: number;
    private gaps = new Samples();
    private steps = new Samples();
    private recoverySteps = new Samples();
    private underrun = false;
    private exhausted = false;
    private underruns = 0;
    private exhaustedEpisodes = 0;
    private underrunFrames = 0;
    private exhaustedFrames = 0;
    get metrics() {
        return { appliedStateGapMs: this.gaps.summary, renderStepMetres: this.steps.summary, recoveryStepMetres: this.recoverySteps.summary,
            interpolationUnderruns: this.underruns, interpolationUnderrunFrames: this.underrunFrames,
            exhaustedRunwayEpisodes: this.exhaustedEpisodes, exhaustedRunwayFrames: this.exhaustedFrames, reserveMs: this.reserve, playbackTime: this.cursor };
    }
    get playbackTime() { return this.cursor; }
    private rendered = new Map<string, { state: PlayerState; offset: Vec3; speed: number; frame: number; extrapolated: boolean }>();
    private grow(desired: number, now: number) {
        desired = clamp(desired, INTERPOLATION_MS, MAX_JITTER_BUFFER_MS);
        if (desired > this.reserve) { this.reserve = desired; this.lastGrowth = now; }
        else if (desired >= this.reserve - 15 && desired > INTERPOLATION_MS + 25) this.lastGrowth = now;
    }
    observe(server: number, local: number) {
        const previous = this.arrivals.at(-1);
        if (previous && server <= previous.server) return;
        if (previous) this.gaps.add(local - previous.local);
        this.arrivals.push({ server, local });
        while (this.arrivals.length > 120) this.arrivals.shift();
        const transits = this.arrivals.map(a => a.local - a.server);
        const floor = Math.min(...transits);
        const jitter = transits.map(t => t - floor).sort((a, b) => a - b);
        const burst = previous ? Math.max(0, local - previous.local - (server - previous.server)) : 0;
        const desired = clamp(INTERPOLATION_MS + Math.max(jitter[Math.floor((jitter.length - 1) * .95)], burst), INTERPOLATION_MS, MAX_JITTER_BUFFER_MS);
        if (desired >= this.reserve - 15) {
            this.grow(desired, local);
        } else if (desired < this.reserve - 25 && local - this.lastGrowth > 30000 && previous) {
            this.reserve = Math.max(desired, this.reserve - (local - previous.local) * .02);
        }
    }
    delay(ping: number) { return Math.min(MAX_INTERPOLATION_DELAY_MS, this.reserve + clamp(ping / 2, 0, 500)); }
    reset() {
        this.arrivals = []; this.reserve = INTERPOLATION_MS; this.lastGrowth = 0;
        this.cursor = undefined; this.lastNow = undefined; this.rendered.clear();
        this.gaps = new Samples(); this.steps = new Samples(); this.recoverySteps = new Samples();
        this.underrun = this.exhausted = false;
        this.underruns = this.exhaustedEpisodes = this.underrunFrames = this.exhaustedFrames = 0;
    }
    sample(frames: RemoteFrame[], id: string, serverNow: number, localNow: number, ping: number): PlayerState[] {
        if (!frames.length) return [];
        const elapsed = this.lastNow === undefined ? 0 : Math.max(0, localNow - this.lastNow);
        this.lastNow = localNow;
        const arrival = this.arrivals.at(-1);
        // Learn during a silence, before its delayed packet finally arrives.
        if (arrival) this.grow(INTERPOLATION_MS + Math.max(0, localNow - arrival.local - 50), localNow);
        const desired = serverNow - this.delay(ping);
        if (this.cursor === undefined) this.cursor = desired;
        else {
            // Change playback rate, never move the clock backwards or pause it
            // when the jitter reserve grows. RTT/clock-offset updates cannot jump it.
            const error = desired - (this.cursor + elapsed);
            this.cursor += elapsed * clamp(1 + error / (error < 0 ? 200 : 1000), .25, 1.1);
        }
        const time = this.cursor;
        let a = frames[0], b = a;
        for (const f of frames) { b = f; if (f.time >= time) break; a = f; }
        const t = clamp((time - a.time) / (b.time - a.time || 1), 0, 1);
        const latest = frames.at(-1)!;
        const late = Math.max(0, time - latest.time);
        if (late > .001) { this.underrunFrames++; if (!this.underrun) this.underruns++; }
        if (late > MAX_EXTRAPOLATION_MS) { this.exhaustedFrames++; if (!this.exhausted) this.exhaustedEpisodes++; }
        this.underrun = late > .001; this.exhausted = late > MAX_EXTRAPOLATION_MS;
        const result: PlayerState[] = [];
        for (const authority of latest.players.values()) {
            if (authority.id === id) continue;
            const buffered = b.players.get(authority.id);
            // New lives enter once at their first pose, then use this same
            // playback path instead of successive unbuffered latest positions.
            const q = buffered?.life === authority.life ? buffered
                : frames.find(f => f.players.get(authority.id)?.life === authority.life)?.players.get(authority.id) ?? authority;
            const p = a.players.get(q.id);
            let target = { ...q };
            // Batched commands can advance more simulation time than the
            // snapshot interval. Preserve the actual historical segment speed
            // on ordinary playback, not just its endpoint's velocity.
            const segmentSpeed = p && p.life === q.life && b.time > a.time
                ? Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z) * 1000 / (b.time - a.time) : 0;
            const targetSpeed = Math.max(segmentSpeed, Math.hypot(q.vx, q.vy, q.vz));
            if (p && p.life === q.life) {
                for (const key of ['x', 'y', 'z', 'vx', 'vy', 'vz', 'pitch', 'slide'] as const) target[key] = lerp(p[key], q[key], t);
                target.yaw = angleLerp(p.yaw, q.yaw, t);
                target.alive = t < 1 ? p.alive : q.alive;
            }
            if (late && q.alive) {
                const speed = Math.hypot(q.vx, q.grounded ? 0 : q.vy, q.vz);
                const seconds = Math.min(late / 1000, MAX_EXTRAPOLATION_MS / 1000, MAX_EXTRAPOLATION_METRES / Math.max(speed, .001));
                Object.assign(target, clipPlayerMotion(q, { x: q.x + q.vx * seconds, y: q.y + (q.grounded ? 0 : q.vy * seconds), z: q.z + q.vz * seconds }, q.slide > 0 ? 1.26 : undefined));
            }
            const previous = this.rendered.get(q.id);
            let offset = previous?.offset ?? { x: 0, y: 0, z: 0 };
            const continuous = previous && previous.state.life === q.life;
            if (!continuous) {
                offset = { x: 0, y: 0, z: 0 };
            } else if (previous.extrapolated && previous.frame !== latest.time) {
                offset = { x: previous.state.x - target.x, y: previous.state.y - target.y, z: previous.state.z - target.z };
            }
            // Both the recovery offset and the final visible displacement are
            // bounded. Sweep FROM the last rendered pose: clipping an offset
            // from the new authority can itself teleport across a solid.
            const seconds = Math.min(elapsed / 1000, 1 / 30);
            const length = Math.hypot(offset.x, offset.y, offset.z);
            const decay = 1 - Math.min(1 - Math.exp(-seconds / .18), REMOTE_CORRECTION_SPEED * seconds / Math.max(length, .000001));
            offset = { x: offset.x * decay, y: offset.y * decay, z: offset.z * decay };
            let position = { x: target.x + offset.x, y: target.y + offset.y, z: target.z + offset.z };
            if (continuous) {
                const from = previous.state, dx = position.x - from.x, dy = position.y - from.y, dz = position.z - from.z;
                const speed = Math.min(Math.hypot(MAX_SPEED, 24), Math.max(previous.speed, targetSpeed));
                const limit = (speed * 1.1 + REMOTE_CORRECTION_SPEED) * seconds;
                const fraction = Math.min(1, limit / Math.max(Math.hypot(dx, dy, dz), .000001));
                position = clipPlayerMotion(from, { x: from.x + dx * fraction, y: from.y + dy * fraction, z: from.z + dz * fraction }, target.slide > 0 ? 1.26 : undefined);
            }
            offset = { x: position.x - target.x, y: position.y - target.y, z: position.z - target.z };
            const state = { ...target, ...position, hp: authority.hp, alive: authority.alive };
            if (continuous) {
                const dx = state.x - previous.state.x, dy = state.y - previous.state.y, dz = state.z - previous.state.z;
                if (elapsed > 0) {
                    state.vx = dx * 1000 / elapsed; state.vy = dy * 1000 / elapsed; state.vz = dz * 1000 / elapsed;
                }
                if (state.alive && previous.state.alive) {
                    this.steps.add(Math.hypot(dx, dy, dz));
                    if (previous.extrapolated && previous.frame !== latest.time) this.recoverySteps.add(Math.hypot(dx, dy, dz));
                }
            }
            this.rendered.set(q.id, { state, offset, speed: targetSpeed, frame: latest.time, extrapolated: late > 0 });
            result.push(state);
        }
        const ids = new Set(result.map(p => p.id));
        for (const key of this.rendered.keys()) if (!ids.has(key)) this.rendered.delete(key);
        return result;
    }
}
