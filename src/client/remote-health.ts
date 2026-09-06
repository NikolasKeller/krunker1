import { clamp } from '../shared/math';
import type { CombatMessage, PlayerState } from '../shared/types';
import type { ProvisionalHit } from './shot-feedback';

type Prediction = { damage: number; shooterLife: number; seq: number };
type Health = {
    life: number; authority: number; max: number; shown: number; target: number; time: number;
    now: number; pending: Map<string, Prediction>; sample?: PlayerState;
};

// Presentation only. Neither authority nor alive/kills/score is written here.
export class RemoteHealth {
    private tracks = new Map<string, Health>();
    reset() { this.tracks.clear(); }
    private track(p: PlayerState, now: number) {
        let h = this.tracks.get(p.id);
        if (!h || h.life !== p.life) {
            h = { life: p.life, authority: p.hp, max: p.maxHp, shown: p.hp, target: p.hp, time: -Infinity, now, pending: new Map() };
            this.tracks.set(p.id, h);
        }
        return h;
    }
    private target(h: Health) {
        return clamp(h.authority - [...h.pending.values()].reduce((sum, p) => sum + p.damage, 0), 0, h.max);
    }
    private write(h: Health) { if (h.sample) h.sample.hp = h.shown; }
    private update(h: Health, p: PlayerState, time: number, reconciled: boolean) {
        if (time < h.time) { h.target = this.target(h); return; }
        const delta = p.hp - h.authority;
        h.time = time; h.authority = p.hp; h.max = p.maxHp;
        h.target = this.target(h);
        // Other players' damage is discrete and immediate. A disagreement with
        // our prediction instead changes the easing target, including a miss.
        if (!reconciled) h.shown = clamp(h.shown + delta, 0, h.max);
        if (!p.alive) { h.pending.clear(); h.shown = h.target = p.hp; }
        this.write(h);
    }
    snapshot(players: Map<string, PlayerState>, local: PlayerState | undefined, time: number, now: number) {
        for (const p of players.values()) {
            if (p.id === local?.id) continue;
            const h = this.track(p, now);
            let reconciled = false;
            // An ACK covers accepted AND rejected fire. If a full snapshot
            // already includes a shot, do not subtract it a second time while
            // waiting for its combat envelope (or after reconnect/resync).
            for (const [key, prediction] of h.pending) if (local && prediction.shooterLife === local.life && prediction.seq <= local.ack) {
                h.pending.delete(key); reconciled = true;
            }
            this.update(h, p, time, reconciled);
        }
        for (const id of this.tracks.keys()) if (!players.has(id)) this.tracks.delete(id);
    }
    resolve(m: CombatMessage, players: Map<string, PlayerState>, localId: string, now: number) {
        const touched = new Set(m.players.map(p => p.id));
        for (const [id, h] of this.tracks) {
            const key = `${m.life}:${m.seq}:${id}`;
            const reconciled = m.shooter === localId && h.pending.delete(key);
            if (!touched.has(id) && !reconciled) continue;
            const p = players.get(id);
            if (!p || p.life !== h.life) continue;
            this.update(h, p, m.time, reconciled);
        }
        for (const patch of m.players) {
            const p = players.get(patch.id);
            if (p && p.id !== localId && !this.tracks.has(p.id)) this.track(p, now);
        }
    }
    predict(hit: ProvisionalHit, players: Map<string, PlayerState>, now: number) {
        const p = players.get(hit.victim);
        if (!p?.alive) return;
        const h = this.track(p, now);
        if (h.pending.has(hit.key)) return;
        const [shooterLife, seq] = hit.key.split(':').map(Number);
        h.pending.set(hit.key, { damage: hit.damage, shooterLife, seq });
        h.shown = clamp(h.shown - hit.damage, 0, h.max);
        h.target = this.target(h);
        this.write(h); // Mutates the shared render sample in the firing frame.
    }
    retract(key: string) {
        for (const h of this.tracks.values()) if (h.pending.delete(key)) h.target = this.target(h);
    }
    sample(p: PlayerState, now: number) {
        const h = this.track(p, now);
        const elapsed = Math.max(0, now - h.now); h.now = now;
        h.shown += (h.target - h.shown) * (1 - Math.exp(-elapsed / 120));
        if (Math.abs(h.shown - h.target) < .01) h.shown = h.target;
        h.sample = p; this.write(h);
        return p;
    }
}
