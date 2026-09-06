import { MAX_HUMANS, type Team } from '../shared/types';
import type { Network } from './network';
import { CLASSES } from '../shared/weapons';
import { summarizeLineup } from '../shared/lobby';

export const LOBBY_UPDATE_MS = 100;
type Field = HTMLInputElement | HTMLSelectElement | HTMLButtonElement;

// This view owns persistent nodes. Snapshot/render frequency never determines DOM writes.
export class LobbyPanel {
    private nodes = new Map<string, HTMLElement>();
    private roster = new Map<string, HTMLElement>();
    private results = new Map<string, HTMLElement>();
    private modes = [...document.querySelectorAll<HTMLButtonElement>('[data-mode]')];
    private teams = [...document.querySelectorAll<HTMLButtonElement>('[data-team]')];
    private lastName = '';
    private polls = 0;
    private updates = 0;
    private writes = 0;
    constructor(private net: Network) {
        document.querySelectorAll<HTMLElement>('.room-panel [id], #connection').forEach(node => this.nodes.set(node.id, node));
    }
    get metrics() { return { intervalMs: LOBBY_UPDATE_MS, polls: this.polls, updates: this.updates, writes: this.writes }; }
    private node(id: string) { return this.nodes.get(id)!; }
    private text(node: HTMLElement, value: string) {
        if (node.textContent === value) return;
        // Keep the text node too, including the one targeted by a text locator.
        if (node.childNodes.length === 1 && node.firstChild?.nodeType === 3) node.firstChild.nodeValue = value;
        else node.textContent = value;
        this.writes++;
    }
    private label(id: string, value: string) { this.text(this.node(id), value); }
    private toggle(node: HTMLElement, name: string, value: boolean) {
        if (node.classList.contains(name) === value) return;
        node.classList.toggle(name, value);
        this.writes++;
    }
    private disabled(node: Field, value: boolean) {
        if (node.disabled === value) return;
        node.disabled = value;
        this.writes++;
    }
    private value(id: string, value: string) {
        const node = this.node(id) as HTMLInputElement | HTMLSelectElement;
        if (document.activeElement === node || node.value === value) return;
        node.value = value;
        this.writes++;
    }
    private attribute(node: HTMLElement, name: string, value: string) {
        if (node.getAttribute(name) === value) return;
        node.setAttribute(name, value);
        this.writes++;
    }
    private rows(parent: HTMLElement, rows: Map<string, HTMLElement>, ids: string[], create: () => HTMLElement, prune = true) {
        const present = new Set(ids);
        for (const [id, row] of rows) if (prune && !present.has(id)) { row.remove(); rows.delete(id); this.writes++; }
        ids.forEach((id, index) => {
            let row = rows.get(id);
            if (!row) { row = create(); rows.set(id, row); }
            if (parent.children[index] !== row) { parent.insertBefore(row, parent.children[index] ?? null); this.writes++; }
        });
    }
    update(team: Team, gameReady = true) {
        this.polls++;
        const before = this.writes, net = this.net, round = net.round, local = net.selectionState ?? net.local;
        const connected = !!local && ['CONNECTED', 'CONNECTION SLOW'].includes(net.status), host = connected && net.host === net.id;
        const active = round?.phase === 'playing', countdown = round?.phase === 'countdown', results = round?.phase === 'results';
        const seconds = Math.max(0, Math.ceil(((round?.nextAt ?? 0) - net.serverNow) / 1000));
        const ready = local?.ready ?? false, deploy = this.node('deploy') as HTMLButtonElement;
        const label = !net.ws ? 'CREATE LOBBY' : !connected ? `${net.status}…` : !gameReady ? 'LOADING ARENA…' : active ? 'JOIN MATCH' : results ? `NEXT ROUND IN ${seconds}` : ready ? '✓ READY · CLICK TO UNREADY' : 'READY UP';
        this.label('connection', net.status === 'CONNECTED' ? `${net.room} · CONNECTED` : net.status);
        this.disabled(deploy, results || (!!net.ws && (!connected || !gameReady)));
        this.toggle(deploy, 'is-ready', ready && !active);
        this.attribute(deploy, 'aria-pressed', String(ready));
        this.label('deploy-label', label);
        this.label('deploy-icon', countdown ? String(seconds) : '↗');
        this.toggle(this.node('force-start'), 'hidden', !host || round?.phase !== 'lobby');
        this.disabled(this.node('force-start') as Field, !gameReady);
        this.label('deploy-note', !gameReady ? 'PREPARING THE ARENA · PICK YOUR CLASS WHILE YOU WAIT' : active ? 'MATCH IN PROGRESS · SPAWN AND PLAY' : countdown ? `EVERYONE DEPLOYS IN ${seconds}…` : 'MATCH STARTS WHEN EVERY PLAYER IS READY');
        this.label('lobby-heading', net.room && net.id ? `FURO LOBBY / ${net.room}` : 'YOUR NEXT FURO ROUND');
        // Keep your card in view, then humans before bots. Combat never reorders the lobby.
        const players = (net.displayPlayers ?? [...net.players.values()]).sort((a, b) => Number(b.id === net.id) - Number(a.id === net.id) || Number(a.bot) - Number(b.bot) || a.id.localeCompare(b.id));
        const lineup = summarizeLineup(players), ffa = round?.mode !== 'tdm';
        this.label('lineup-title', ffa ? 'MEET YOUR MATCH' : 'CHOOSE YOUR SIDE');
        this.label('lobby-status', !net.ws ? 'Create a lobby, then invite your friends.' : !connected ? net.status : net.status === 'CONNECTION SLOW' ? 'Connection slow · waiting for updates…' : countdown ? `MATCH STARTING IN ${seconds}…` : active ? 'Round live. You can join at any time.' : results ? 'Good game! Getting the lobby ready…' : `${lineup.ready} / ${lineup.humans} ready · ${ffa ? 'Pick a class' : 'Pick a team'} and ready up.`);
        this.label('ready-count', active || results ? String(lineup.total) : `${lineup.ready} / ${lineup.humans}`);
        this.label('readiness-label', active || results ? 'IN THE LINEUP' : 'PLAYERS READY');
        this.toggle(this.node('ready-count'), 'all-ready', lineup.allReady && !active && !results);
        this.label('waiting-players', active ? 'MATCH IN PROGRESS' : results ? 'NEXT ROUND · Ready states reset after every match.' : !connected ? 'Share a room. Settle the score.' : lineup.waiting.length ? `WAITING FOR · ${lineup.waiting.map(p => p.id === net.id ? `${p.name} (you)` : p.name).join(', ')}` : lineup.allReady ? '✓ EVERYONE IS READY' : 'Invite your friends to fill the lineup.');
        this.toggle(this.node('waiting-players'), 'all-ready', lineup.allReady && !active && !results);
        this.toggle(this.node('lobby-status'), 'counting', countdown);
        this.label('host-label', host ? 'YOU ARE THE HOST' : 'HOST CONTROLS');
        this.label('bot-settings-status', !connected ? 'CREATE OR JOIN A LOBBY' : active || results ? 'APPLIES NEXT ROUND TOO' : host ? 'YOU ARE THE HOST' : 'SET BY THE HOST');
        for (const b of this.modes) {
            this.toggle(b, 'selected', b.dataset.mode === round?.mode);
            this.disabled(b, !host || active || results);
        }
        for (const id of ['difficulty', 'bot-count', 'score-limit', 'time-limit']) this.disabled(this.node(id) as Field, !host || active || results);
        this.disabled(this.node('player-name') as Field, active);
        if (local && local.name !== this.lastName) { this.value('player-name', local.name); this.lastName = local.name; }
        if (!local) this.lastName = '';
        this.value('difficulty', net.difficulty);
        this.value('bot-count', String(net.bots));
        if (round) { this.value('score-limit', String(round.scoreLimit)); this.value('time-limit', String(round.duration)); }
        for (const b of this.teams) {
            const selected = b.dataset.team === (local?.team ?? team);
            this.toggle(b, 'selected', selected);
            this.attribute(b, 'aria-pressed', String(selected));
            this.attribute(b, 'aria-label', `Join ${b.dataset.team} team`);
            this.disabled(b, !connected || results);
            this.toggle(b.parentElement!, 'is-local-team', selected && connected);
            this.toggle(b.parentElement!, 'can-join', connected && !results);
            this.label(`${b.dataset.team}-action`, selected && connected ? '✓ YOUR TEAM' : results ? 'TEAM LOCKED' : 'JOIN TEAM ↗');
        }
        this.label('player-count', `${lineup.humans} / ${MAX_HUMANS} + ${lineup.bots} BOTS`);
        this.label('lineup-help', results ? 'The lineup returns here after the match.' : active ? 'Class changes apply now. Switching team moves you to its spawn. Health stays unchanged.' : ffa ? 'No teams. Every player is a rival.' : host ? 'Click a team to join · Use MOVE on a card to set the matchups.' : 'Click a team to join it.');
        document.querySelectorAll<HTMLButtonElement>('[data-class]').forEach(b => this.disabled(b, results));
        this.toggle(this.node('roster'), 'is-ffa', ffa);
        const focused = document.activeElement as HTMLElement | null;
        const focusedCard = focused?.closest('[data-player-id]');
        for (const [id, row] of this.roster) if (!net.players.has(id)) { row.remove(); this.roster.delete(id); this.writes++; }
        const createCard = () => {
            const row = document.createElement('div');
            row.className = 'lineup-card';
            row.setAttribute('role', 'listitem');
            row.innerHTML = '<div class="player-identity"><div class="player-name-row"><strong class="player-name"></strong><span class="player-badge you-badge">YOU</span><span class="player-badge host-badge">HOST</span><span class="player-badge bot-badge">BOT</span></div><span class="player-class"></span></div><div class="player-status"><span class="ready-state"></span><button class="move-player"></button></div>';
            row.querySelector('button')!.onclick = () => {
                const p = net.players.get(row.dataset.playerId!);
                if (p && net.host === net.id && ['CONNECTED', 'CONNECTION SLOW'].includes(net.status) && net.round?.mode === 'tdm' && ['lobby', 'countdown'].includes(net.round.phase))
                    net.send({ type: 'team', playerId: p.id, team: p.team === 'blue' ? 'red' : 'blue' });
            };
            return row;
        };
        for (const side of ['blue', 'red', 'ffa'] as const) {
            const group = side === 'ffa' ? players : lineup[side];
            const summary = summarizeLineup(group);
            this.toggle(this.node(`team-${side}`), 'hidden', side === 'ffa' ? !ffa : ffa);
            this.label(`${side}-count`, `${group.length}`);
            this.label(`${side}-summary`, `${group.length} ${group.length === 1 ? 'PLAYER' : 'PLAYERS'} · ${active || results ? `${summary.bots} BOTS` : `${summary.ready}/${summary.humans} READY${summary.bots ? ` + ${summary.bots} BOTS` : ''}`}`);
            this.toggle(this.node(`${side}-empty`), 'hidden', group.length > 0);
            if ((side === 'ffa') === ffa)
                this.rows(this.node(`${side}-roster`), this.roster, group.map(p => p.id), createCard, false);
        }
        for (const p of players) {
            const row = this.roster.get(p.id)!;
            const identity = row.children[0] as HTMLElement, status = row.children[1] as HTMLElement;
            const [name, you, hostBadge, bot] = [...identity.children[0].children] as HTMLElement[];
            const move = status.children[1] as HTMLButtonElement;
            this.attribute(row, 'data-player-id', p.id);
            this.toggle(row, 'is-self', p.id === net.id);
            this.toggle(row, 'is-ready', p.ready || p.bot);
            this.toggle(row, 'is-waiting', !p.ready && !p.bot && !active && !results);
            this.text(name, p.name);
            this.toggle(you, 'hidden', p.id !== net.id);
            this.toggle(hostBadge, 'hidden', p.id !== net.host);
            this.toggle(bot, 'hidden', !p.bot);
            this.text(identity.children[1] as HTMLElement, `${CLASSES[p.classId].name} · ${CLASSES[p.classId].role}`);
            this.text(status.children[0] as HTMLElement, active ? 'IN MATCH' : results ? 'NEXT ROUND' : p.ready || p.bot ? '✓ READY' : '○ NOT READY');
            this.toggle(move, 'hidden', !host || ffa || p.id === net.id);
            this.disabled(move, !connected || active || results);
            this.text(move, p.team === 'blue' ? 'MOVE TO RED →' : '← MOVE TO BLUE');
            this.attribute(move, 'aria-label', `Move ${p.name} to ${p.team === 'blue' ? 'red' : 'blue'} team`);
        }
        if (focusedCard?.isConnected && focused && focused !== document.activeElement && !focused.classList.contains('hidden')) {
            focused.focus({ preventScroll: true });
        }
        this.toggle(this.node('lobby-results'), 'hidden', !round?.results);
        const scores = round?.results ?? [];
        if (round?.results) {
            this.label('result-winner', round.winner === 'DRAW' ? 'DRAW' : `${round.winner} WINS`);
            this.label('result-round', `ROUND ${round.round} RESULTS`);
        }
        this.rows(this.node('result-list'), this.results, scores.map(p => p.id), () => {
            const row = document.createElement('div');
            row.append(document.createElement('b'), document.createElement('small'));
            return row;
        });
        scores.forEach((p, i) => {
            const row = this.results.get(p.id)!;
            this.text(row.children[0] as HTMLElement, `${i + 1}. ${p.name}`);
            this.text(row.children[1] as HTMLElement, `${p.kills} K / ${p.deaths} D · ${p.score} PTS`);
        });
        if (this.writes !== before) this.updates++;
    }
}
