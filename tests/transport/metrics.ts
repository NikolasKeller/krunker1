// Diagnostic code only. Nothing in src/ imports this experiment.
import type { PlayerPatch, ServerMessage } from '../../src/shared/types';

export class IndependentReplica {
    n = 0;
    players = new Map<string, PlayerPatch>();
    apply(m: Extract<ServerMessage, { type: 'snapshot' }>) {
        if (!Number.isSafeInteger(m.n) || m.n < 1 || !m.full) throw Error('expected sequenced independent state');
        if (m.n <= this.n) return false;
        const next = new Map<string, PlayerPatch>();
        for (const p of m.players) {
            if (next.has(p.id) || ![p.x, p.y, p.z, p.hp].every(Number.isFinite)) throw Error('invalid full state');
            next.set(p.id, { ...p });
        }
        this.players = next; this.n = m.n;
        return true;
    }
}

export function distribution(values: number[]) {
    const sorted = [...values].sort((a, b) => a - b);
    const at = (p: number) => sorted[Math.floor((sorted.length - 1) * p)] ?? null;
    return { samples: sorted.length, p50: at(.5), p95: at(.95), p99: at(.99), max: sorted.at(-1) ?? null };
}

export type Arrival = { n: number; sent: number; arrived: number; bytes: number; applied: boolean };
export function arrivalReport(rows: Arrival[], started: number, ended: number) {
    const applied = rows.filter(r => r.applied);
    const gaps = applied.slice(1).map((r, i) => r.arrived - applied[i].arrived);
    const sourceGaps = applied.slice(1).map((r, i) => r.sent - applied[i].sent);
    // A burst can contain many callbacks but yield only one visible frame.
    const frames = [...new Set(applied.map(r => Math.floor((r.arrived - started) / (1000 / 60))))];
    const frameGaps = frames.slice(1).map((n, i) => (n - frames[i]) * 1000 / 60);
    const silence = [applied.length ? applied[0].arrived - started : ended - started,
        ended - (applied.at(-1)?.arrived ?? started), ...gaps];
    return {
        received: rows.length, applied: applied.length, rejected: rows.length - applied.length,
        bytes: rows.reduce((n, r) => n + r.bytes, 0),
        appliedGapMs: distribution(gaps), sourceGapMs: distribution(sourceGaps),
        deliveryGapExcessMs: distribution(gaps.map((g, i) => g - sourceGaps[i])),
        frame60HzGapMs: distribution(frameGaps), maxSilenceIncludingEdgesMs: Math.max(0, ...silence),
        burstGapsUnder5Ms: gaps.filter(g => g < 5).length,
    };
}
