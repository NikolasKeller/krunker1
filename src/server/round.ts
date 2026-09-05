import type { Mode, PlayerState, RoundState } from '../shared/types';
export function newRound(mode: Mode = 'ffa'): RoundState { return { phase: 'lobby', mode, endsAt: 0, round: 0, scoreLimit: 25, duration: 240000, blue: 0, red: 0, winner: '', nextAt: 0 }; }
export function startRound(r: RoundState, now: number) { Object.assign(r, { phase: 'playing', endsAt: now + r.duration, round: r.round + 1, blue: 0, red: 0, winner: '', nextAt: 0, results: undefined }); }
export function checkRound(r: RoundState, players: Iterable<PlayerState>, now: number): boolean {
    if (r.phase !== 'playing')
        return false;
    const list = [...players].sort((a, b) => b.kills - a.kills || b.score - a.score);
    const limit = r.mode === 'tdm' ? Math.max(r.blue, r.red) >= r.scoreLimit : list.some(p => p.kills >= r.scoreLimit);
    if (!limit && now < r.endsAt)
        return false;
    r.phase = 'results';
    r.nextAt = now + 6000;
    r.results = list.map(({ id, name, team, kills, deaths, score, bot }) => ({ id, name, team, kills, deaths, score, bot }));
    r.winner = r.mode === 'tdm' ? (r.blue === r.red ? 'DRAW' : r.blue > r.red ? 'BLUE TEAM' : 'RED TEAM') : (!list[0] || (list[1]?.kills === list[0].kills && list[1]?.score === list[0].score) ? 'DRAW' : list[0].name);
    return true;
}
