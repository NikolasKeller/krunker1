import { INTERPOLATION_MS, type ClientMessage, type GameEvent, type Input, type PlayerState, type RoundState, type ServerMessage, type ClassId, type Team, type Difficulty } from '../shared/types';
import { predictInput, reconcile } from './prediction';
import { angleLerp, clamp, lerp } from '../shared/math';
export class Network {
    ws?: WebSocket;
    id = '';
    room = '';
    host = '';
    status = 'CREATE OR JOIN A LOBBY';
    ping = 0;
    offset = 0;
    seq = 0;
    players = new Map<string, PlayerState>();
    predicted?: PlayerState;
    round?: RoundState;
    difficulty: Difficulty = 'normal';
    bots = 5;
    pending: Input[] = [];
    outgoing: Input[] = [];
    frames: {
        time: number;
        players: Map<string, PlayerState>;
    }[] = [];
    correction = { x: 0, y: 0, z: 0 };
    onEvents: (events: GameEvent[]) => void = () => { };
    onNotice: (text: string) => void = () => { };
    onWelcome: () => void = () => { };
    lastSnapshot = 0;
    receivedAt = 0;
    bytes = 0;
    reconciliations = 0;
    maxCorrection = 0;
    private retry = 0;
    private generation = 0;
    private reconnectTimer?: ReturnType<typeof setTimeout>;
    private config?: {
        name: string;
        room: string;
        classId: ClassId;
        team: Team;
        create?: boolean;
    };
    constructor() { setInterval(() => { this.send({ type: 'ping', time: Date.now() }); if (this.ws?.readyState === WebSocket.OPEN && Date.now() - this.receivedAt > 6000 && this.receivedAt > 0)
        this.status = 'CONNECTION STALLED'; }, 1500); }
    connect(config: {
        name: string;
        room: string;
        classId: ClassId;
        team: Team;
        create?: boolean;
    }) {
        this.config = config;
        const generation = ++this.generation;
        clearTimeout(this.reconnectTimer);
        this.ws?.close();
        this.status = 'CONNECTING';
        this.id = '';
        this.host = '';
        this.seq = 0;
        this.round = undefined;
        this.receivedAt = 0;
        this.players.clear();
        this.frames = [];
        this.predicted = undefined;
        this.pending = [];
        this.outgoing = [];
        this.lastSnapshot = 0;
        const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
        this.ws = ws;
        ws.onopen = () => { if (generation !== this.generation)
            return; this.status = 'CONNECTED'; this.retry = 0; this.send({ type: 'join', ...config, token: sessionStorage.getItem(`arena-token-${config.room}`) ?? undefined }); this.send({ type: 'ping', time: Date.now() }); };
        ws.onmessage = e => { if (generation !== this.generation)
            return; try {
            this.bytes += e.data.length;
            this.receive(JSON.parse(e.data));
        }
        catch (error) {
            console.error('Invalid server message', error);
        } };
        ws.onclose = e => { if (generation !== this.generation)
            return; this.status = e.code === 4000 ? 'SESSION MOVED' : 'RECONNECTING'; if (e.code !== 4000)
            this.reconnectTimer = setTimeout(() => this.connect(config), Math.min(5000, 600 * 2 ** this.retry++)); };
        ws.onerror = () => { this.status = 'SERVER UNREACHABLE'; };
    }
    send(message: ClientMessage) { if (this.ws?.readyState === WebSocket.OPEN)
        this.ws.send(JSON.stringify(message)); }
    get serverNow() { return Date.now() + this.offset; }
    get local() { return this.players.get(this.id); }
    input(i: Input) { if (!this.predicted)
        return; this.pending.push(i); this.outgoing.push(i); if (this.pending.length > 240) {
        this.pending = [];
        this.predicted = { ...this.local! };
        this.send({ type: 'sync' });
        return;
    } predictInput(this.predicted, i, this.round?.phase === 'playing'); if (this.outgoing.length >= 2)
        this.flush(); }
    flush() { if (this.outgoing.length) {
        this.send({ type: 'input', inputs: this.outgoing.splice(0, 12) });
    } }
    private receive(m: ServerMessage) {
        if (m.type === 'welcome') {
            this.id = m.id;
            this.room = m.room;
            this.host = m.host;
            this.offset = m.serverTime - Date.now();
            this.config!.room = m.room;
            this.config!.create = false;
            sessionStorage.setItem(`arena-token-${m.room}`, m.token);
            this.onWelcome();
        }
        if (m.type === 'pong') {
            const rtt = Date.now() - m.time;
            this.ping = Math.round(rtt);
            const offset = m.serverTime - (m.time + rtt / 2);
            this.offset = lerp(this.offset, offset, 0.2);
        }
        if (m.type === 'error') {
            this.status = m.message;
            this.onNotice(m.message);
        }
        if (m.type === 'events')
            this.onEvents(m.events);
        if (m.type === 'snapshot') {
            if (!m.full && m.base !== this.lastSnapshot) {
                this.send({ type: 'sync' });
                return;
            }
            this.receivedAt = Date.now();
            this.status = 'CONNECTED';
            this.lastSnapshot = m.n;
            if (m.host !== undefined) this.host = m.host;
            if (m.round) this.round = m.round;
            if (m.difficulty) this.difficulty = m.difficulty;
            if (m.bots !== undefined) this.bots = m.bots;
            if (m.full)
                this.players.clear();
            for (const patch of m.players) {
                const prev = this.players.get(patch.id);
                this.players.set(patch.id, { ...prev, ...patch } as PlayerState);
            }
            for (const id of m.removed)
                this.players.delete(id);
            this.frames.push({ time: m.time, players: new Map([...this.players].map(([id, p]) => [id, { ...p }])) });
            while (this.frames.length > 32)
                this.frames.shift();
            const local = this.local;
            if (local) {
                const old = this.predicted, replayed = reconcile(local, this.pending, this.round?.phase === 'playing');
                this.pending = replayed.remaining;
                this.seq = Math.max(this.seq, local.ack);
                this.predicted = replayed.predicted;
                if (old && old.life === local.life) {
                    const dx = old.x - this.predicted.x, dy = old.y - this.predicted.y, dz = old.z - this.predicted.z;
                    const error = Math.hypot(dx, dy, dz);
                    this.maxCorrection = Math.max(this.maxCorrection, error);
                    if (error > 0.01)
                        this.reconciliations++;
                    if (error < 3) {
                        this.correction.x += dx;
                        this.correction.y += dy;
                        this.correction.z += dz;
                    }
                    else
                        this.correction = { x: 0, y: 0, z: 0 };
                }
                else {
                    this.pending = [];
                    this.outgoing = [];
                    this.correction = { x: 0, y: 0, z: 0 };
                }
            }
        }
    }
    remotePlayers(): PlayerState[] {
        const time = this.serverNow - INTERPOLATION_MS;
        let a = this.frames[0], b = a;
        if (!a)
            return [];
        for (const f of this.frames) {
            b = f;
            if (f.time >= time)
                break;
            a = f;
        }
        const t = clamp((time - a.time) / (b.time - a.time || 1), 0, 1);
        return [...b.players.values()].filter(p => p.id !== this.id).map(q => { const p = a.players.get(q.id); if (!p || p.life !== q.life)
            return q; return { ...q, x: lerp(p.x, q.x, t), y: lerp(p.y, q.y, t), z: lerp(p.z, q.z, t), yaw: angleLerp(p.yaw, q.yaw, t), pitch: lerp(p.pitch, q.pitch, t) }; });
    }
}
