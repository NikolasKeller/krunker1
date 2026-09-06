import { angleLerp, clamp, lerp } from '../shared/math';
import { clipPlayerMotion } from '../shared/collision';
import { INTERPOLATION_MS, type PlayerState, type Vec3 } from '../shared/types';
export interface RemoteFrame { time: number; players: Map<string, PlayerState> }
export const MAX_EXTRAPOLATION_MS = 250;
export const MAX_JITTER_BUFFER_MS = 500;

export class RemoteInterpolation {
    reserve = INTERPOLATION_MS;
    private arrivals: { server: number; local: number }[] = [];
    private lastGrowth = 0;
    private lastNow?: number;
    private cursor?: number;
    get playbackTime() { return this.cursor; }
    private rendered = new Map<string, { state: PlayerState; offset: Vec3; hpOffset: number; frame: number; extrapolated: boolean }>();
    observe(server: number, local: number) {
        const previous = this.arrivals.at(-1);
        if (previous && server <= previous.server) return;
        this.arrivals.push({ server, local });
        while (this.arrivals.length > 120) this.arrivals.shift();
        const transits = this.arrivals.map(a => a.local - a.server);
        const floor = Math.min(...transits);
        const jitter = transits.map(t => t - floor).sort((a, b) => a - b);
        const burst = previous ? Math.max(0, local - previous.local - (server - previous.server)) : 0;
        const desired = clamp(INTERPOLATION_MS + Math.max(jitter[Math.floor((jitter.length - 1) * .95)], burst), INTERPOLATION_MS, MAX_JITTER_BUFFER_MS);
        if (desired > this.reserve + 15) {
            this.reserve = desired; this.lastGrowth = local;
        } else if (desired < this.reserve - 25 && local - this.lastGrowth > 5000 && previous) {
            this.reserve = Math.max(desired, this.reserve - (local - previous.local) * .01);
        }
    }
    delay(ping: number) { return this.reserve + clamp(ping / 2, 0, 500); }
    reset() {
        this.arrivals = []; this.reserve = INTERPOLATION_MS; this.lastGrowth = 0;
        this.cursor = undefined; this.lastNow = undefined; this.rendered.clear();
    }
    sample(frames: RemoteFrame[], id: string, serverNow: number, localNow: number, ping: number): PlayerState[] {
        if (!frames.length) return [];
        const elapsed = this.lastNow === undefined ? 0 : Math.max(0, localNow - this.lastNow);
        this.lastNow = localNow;
        const desired = serverNow - this.delay(ping);
        if (this.cursor === undefined) this.cursor = desired;
        else {
            // Change playback rate, never move the clock backwards or pause it
            // when the jitter reserve grows. RTT/clock-offset updates cannot jump it.
            const error = desired - (this.cursor + elapsed);
            this.cursor += elapsed * clamp(1 + error / 1000, .75, 1.1);
        }
        const time = this.cursor;
        let a = frames[0], b = a;
        for (const f of frames) { b = f; if (f.time >= time) break; a = f; }
        const t = clamp((time - a.time) / (b.time - a.time || 1), 0, 1);
        const latest = frames.at(-1)!;
        const late = Math.max(0, time - latest.time);
        const result: PlayerState[] = [];
        for (const q of b.players.values()) {
            if (q.id === id || !latest.players.has(q.id)) continue;
            const p = a.players.get(q.id);
            let target = { ...q };
            if (p && p.life === q.life) {
                for (const key of ['x', 'y', 'z', 'vx', 'vy', 'vz', 'pitch', 'hp', 'slide'] as const) target[key] = lerp(p[key], q[key], t);
                target.yaw = angleLerp(p.yaw, q.yaw, t);
                target.alive = t < 1 ? p.alive : q.alive;
            }
            if (late && q.alive) {
                const seconds = Math.min(late, MAX_EXTRAPOLATION_MS) / 1000;
                Object.assign(target, clipPlayerMotion(q, { x: q.x + q.vx * seconds, y: q.y + (q.grounded ? 0 : q.vy * seconds), z: q.z + q.vz * seconds }, q.slide > 0 ? 1.26 : undefined));
            }
            const previous = this.rendered.get(q.id);
            let offset = previous?.offset ?? { x: 0, y: 0, z: 0 }, hpOffset = previous?.hpOffset ?? 0;
            if (!previous || previous.state.life !== q.life || previous.state.alive !== target.alive) {
                offset = { x: 0, y: 0, z: 0 }; hpOffset = 0;
            } else if (previous.extrapolated && previous.frame !== latest.time) {
                offset = { x: previous.state.x - target.x, y: previous.state.y - target.y, z: previous.state.z - target.z };
                hpOffset = previous.state.hp - target.hp;
            }
            const decay = Math.exp(-12 * elapsed / 1000);
            offset = { x: offset.x * decay, y: offset.y * decay, z: offset.z * decay };
            hpOffset *= decay;
            const state = { ...target, ...clipPlayerMotion(target, { x: target.x + offset.x, y: target.y + offset.y, z: target.z + offset.z }, target.slide > 0 ? 1.26 : undefined), hp: clamp(target.hp + hpOffset, 0, target.maxHp) };
            this.rendered.set(q.id, { state, offset, hpOffset, frame: latest.time, extrapolated: late > 0 });
            result.push(state);
        }
        const ids = new Set(result.map(p => p.id));
        for (const key of this.rendered.keys()) if (!ids.has(key)) this.rendered.delete(key);
        return result;
    }
}
