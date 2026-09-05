import { MAX_HUMANS, type Team } from '../shared/types';
import type { Network } from './network';

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
    private rows(parent: HTMLElement, rows: Map<string, HTMLElement>, ids: string[], create: () => HTMLElement) {
        const present = new Set(ids);
        for (const [id, row] of rows) if (!present.has(id)) { row.remove(); rows.delete(id); this.writes++; }
        ids.forEach((id, index) => {
            let row = rows.get(id);
            if (!row) { row = create(); rows.set(id, row); }
            if (parent.children[index] !== row) { parent.insertBefore(row, parent.children[index] ?? null); this.writes++; }
        });
    }
    update(team: Team) {
        this.polls++;
        const before = this.writes, net = this.net, round = net.round, local = net.local;
        const connected = !!local && net.status === 'CONNECTED', host = connected && net.host === net.id;
        const active = round?.phase === 'playing', countdown = round?.phase === 'countdown', results = round?.phase === 'results';
        const seconds = Math.max(0, Math.ceil(((round?.nextAt ?? 0) - net.serverNow) / 1000));
        const ready = local?.ready ?? false, deploy = this.node('deploy') as HTMLButtonElement;
        const label = !net.ws ? 'CREATE LOBBY' : !connected ? 'CONNECTING…' : active ? 'JOIN MATCH' : results ? `NEXT ROUND IN ${seconds}` : ready ? '✓ READY · CLICK TO UNREADY' : 'READY UP';
        this.label('connection', net.status === 'CONNECTED' ? `${net.room} · CONNECTED` : net.status);
        this.disabled(deploy, results || (!!net.ws && !connected));
        this.toggle(deploy, 'is-ready', ready && !active);
        this.attribute(deploy, 'aria-pressed', String(ready));
        this.label('deploy-label', label);
        this.label('deploy-icon', countdown ? String(seconds) : '↗');
        this.toggle(this.node('force-start'), 'hidden', !host || round?.phase !== 'lobby');
        this.label('deploy-note', active ? 'MATCH IN PROGRESS · SPAWN AND PLAY' : countdown ? `EVERYONE DEPLOYS IN ${seconds}…` : 'MATCH STARTS WHEN EVERY PLAYER IS READY');
        this.label('lobby-heading', net.room && net.id ? `LOBBY / ${net.room}` : 'YOUR NEXT ROUND');
        // Lobby ordering is independent of in-match scores, so movement and combat cannot reorder it.
        const players = [...net.players.values()].sort((a, b) => Number(a.bot) - Number(b.bot) || a.id.localeCompare(b.id));
        const humans = players.filter(p => !p.bot);
        this.label('lobby-status', !net.ws ? 'Create a lobby, then invite your friends.' : !connected ? net.status : countdown ? `MATCH STARTING IN ${seconds}…` : active ? 'Round live. You can join at any time.' : results ? 'Good game! Getting the lobby ready…' : `${humans.filter(p => p.ready).length} / ${humans.length} ready · Pick a team and ready up.`);
        this.toggle(this.node('lobby-status'), 'counting', countdown);
        this.label('host-label', host ? 'YOU ARE THE HOST' : 'HOST CONTROLS');
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
            this.toggle(b, 'selected', b.dataset.team === (local?.team ?? team));
            this.disabled(b, active);
        }
        this.label('player-count', `${humans.length} / ${MAX_HUMANS} + ${players.length - humans.length} BOTS`);
        this.rows(this.node('roster'), this.roster, players.map(p => p.id), () => {
            const row = document.createElement('div');
            row.className = 'roster-player';
            row.innerHTML = '<span class="roster-dot"></span><span><span></span><small></small><small></small></span><small></small><small class="ready-state"></small>';
            return row;
        });
        for (const p of players) {
            const row = this.roster.get(p.id)!;
            const [dot, name, side, status] = [...row.children] as HTMLElement[];
            this.attribute(row, 'data-player-id', p.id);
            for (const color of ['blue', 'red']) { this.toggle(dot, color, p.team === color); this.toggle(side, color, p.team === color); }
            this.text(name.children[0] as HTMLElement, p.name);
            this.text(name.children[1] as HTMLElement, p.id === net.id ? ' YOU' : '');
            this.text(name.children[2] as HTMLElement, p.id === net.host ? ' HOST' : '');
            this.text(side, p.team.toUpperCase());
            this.toggle(status, 'ready', p.ready || p.bot);
            this.text(status, p.bot ? 'BOT' : p.ready ? '✓ READY' : 'NOT READY');
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
