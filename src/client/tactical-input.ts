import type { Input, PlayerState } from '../shared/types';

// Request latches prevent repeats before an ACK arrives. Only snapshots grant
// effects/cooldowns; locally editing this gate cannot bypass server authority.
export class TacticalInput {
    private pending = new Map<'ability' | 'grenade', { seq: number; life: number }>();
    clear() { this.pending.clear(); }
    prepare(input: Input, p: PlayerState, playing: boolean, now: number): Input {
        const next = { ...input };
        for (const tool of ['ability', 'grenade'] as const) {
            const pending = this.pending.get(tool);
            if (pending && (pending.life !== p.life || p.ack >= pending.seq)) this.pending.delete(tool);
            const readyAt = tool === 'ability' ? p.abilityReadyAt : p.grenadeReadyAt;
            if (!next[tool]) continue;
            if (!playing || !p.alive || this.pending.has(tool) || now < (readyAt ?? 0) ||
                (tool === 'ability' && p.classId === 'triggerman' && p.hp >= p.maxHp)) delete next[tool];
            else this.pending.set(tool, { seq: input.seq, life: p.life });
        }
        return next;
    }
}
