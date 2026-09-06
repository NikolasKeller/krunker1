import type { PlayerState } from './types';

// Callers supply connected players. Bots occupy slots, but never hold up a start.
export function summarizeLineup(players: Iterable<PlayerState>) {
    const lineup = [...players];
    const humans = lineup.filter(p => !p.bot);
    const waiting = humans.filter(p => !p.ready);
    return {
        total: lineup.length,
        humans: humans.length,
        bots: lineup.length - humans.length,
        ready: humans.length - waiting.length,
        waiting,
        allReady: humans.length > 0 && waiting.length === 0,
        blue: lineup.filter(p => p.team === 'blue'),
        red: lineup.filter(p => p.team === 'red'),
    };
}
