import { INTERPOLATION_MS, type ClientMessage, type GameEvent, type Input, type PlayerState, type RoundState, type ServerMessage, type ClassId, type Team, type Difficulty } from '../shared/types';
import { predictInput, reconcile } from './prediction';
import { angleLerp, clamp, lerp } from '../shared/math';
import { decodeServerMessage, encodeClientMessage, INPUT_SEND_MS, WIRE_PROTOCOL } from '../shared/protocol';
import { InputBuffer } from '../shared/input-buffer';
export const JOIN_RETRY_MS = 1500;
export const CONNECT_TIMEOUT_MS = 10000;
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
    readonly inputs = new InputBuffer();
    get pending() { return this.inputs.pending; }
    set pending(value: Input[]) { this.inputs.pending = value; }
    get outgoing() { return this.inputs.outgoing; }
    set outgoing(value: Input[]) { this.inputs.outgoing = value; }
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
    private handshakeTimer?: ReturnType<typeof setTimeout>;
    private joinTimer?: ReturnType<typeof setInterval>;
    private inputTimer?: ReturnType<typeof setInterval>;
    private heartbeatTimer: ReturnType<typeof setInterval>;
    private tokens = new Map<string, string>();
    private config?: {
        name: string;
        room: string;
        classId: ClassId;
        team: Team;
        create?: boolean;
    };
    constructor() { this.heartbeatTimer = setInterval(() => {
        this.send({ type: 'ping', time: Date.now() });
        if (this.ws?.readyState === WebSocket.OPEN && this.receivedAt > 0 && Date.now() - this.receivedAt > 6000)
            this.connect(this.config!);
    }, 1500); }
    private clearHandshake() {
        clearTimeout(this.handshakeTimer);
        clearInterval(this.joinTimer);
    }
    disconnect() {
        ++this.generation;
        this.clearHandshake();
        clearTimeout(this.reconnectTimer);
        clearInterval(this.heartbeatTimer);
        clearInterval(this.inputTimer);
        this.ws?.close();
        this.ws = undefined;
        this.status = 'DISCONNECTED';
    }
    connect(config: {
        name: string;
        room: string;
        classId: ClassId;
        team: Team;
        create?: boolean;
    }) {
        this.config = config = { ...config };
        const generation = ++this.generation;
        this.clearHandshake();
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
        this.inputs.clear();
        this.lastSnapshot = 0;
        const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`, WIRE_PROTOCOL);
        ws.binaryType = 'arraybuffer';
        this.ws = ws;
        clearInterval(this.inputTimer);
        this.inputTimer = setInterval(() => this.flush(), INPUT_SEND_MS);
        const reconnect = () => {
            if (generation !== this.generation) return;
            ++this.generation;
            this.clearHandshake();
            this.status = 'RECONNECTING';
            ws.close();
            this.reconnectTimer = setTimeout(() => this.connect(config), Math.min(5000, 600 * 2 ** this.retry++));
        };
        this.handshakeTimer = setTimeout(reconnect, CONNECT_TIMEOUT_MS);
        ws.onopen = () => {
            if (generation !== this.generation) return;
            this.status = 'JOINING LOBBY';
            let token = this.tokens.get(config.room);
            // Storage is optional: a privacy policy must not prevent the join from being sent.
            try { token ??= sessionStorage.getItem(`arena-token-${config.room}`) ?? undefined; } catch { /* Use the in-memory token. */ }
            const join: ClientMessage = { type: 'join', ...config, token };
            const requestLobby = () => {
                if (generation !== this.generation) return;
                this.send(this.id ? { type: 'sync' } : join);
            };
            requestLobby();
            this.send({ type: 'ping', time: Date.now() });
            this.joinTimer = setInterval(requestLobby, JOIN_RETRY_MS);
            clearTimeout(this.handshakeTimer);
            this.handshakeTimer = setTimeout(reconnect, CONNECT_TIMEOUT_MS);
        };
        ws.onmessage = e => { if (generation !== this.generation)
            return; try {
            this.bytes += typeof e.data === 'string' ? new TextEncoder().encode(e.data).length : e.data.byteLength;
            this.receive(decodeServerMessage(e.data));
        }
        catch (error) {
            console.error('Invalid server message', error);
        } };
        ws.onclose = e => {
            if (generation !== this.generation) return;
            this.clearHandshake();
            if (e.code === 4000) this.status = 'SESSION MOVED';
            else reconnect();
        };
        ws.onerror = () => { if (generation === this.generation) this.status = 'SERVER UNREACHABLE'; };
    }
    send(message: ClientMessage) { if (this.ws?.readyState === WebSocket.OPEN)
        this.ws.send(encodeClientMessage(message)); }
    get serverNow() { return Date.now() + this.offset; }
    get local() { return this.players.get(this.id); }
    input(input: Input) {
        if (!this.predicted) return;
        const dropped = this.inputs.dropped;
        const i = this.inputs.enqueue({ ...input, life: this.predicted.life });
        const playing = this.round?.phase === 'playing';
        if (this.inputs.dropped !== dropped && this.local)
            this.predicted = reconcile(this.local, this.pending, playing).predicted;
        else predictInput(this.predicted, i, playing);
    }
    flush() { if (this.ws) this.inputs.flush(this.ws); }
    private receive(m: ServerMessage) {
        if (m.type === 'welcome') {
            const firstWelcome = this.id !== m.id || this.room !== m.room;
            this.id = m.id;
            this.room = m.room;
            this.host = m.host;
            this.offset = m.serverTime - Date.now();
            this.config!.room = m.room;
            this.config!.create = false;
            this.tokens.set(m.room, m.token);
            try { sessionStorage.setItem(`arena-token-${m.room}`, m.token); } catch { /* The session can still resume in memory. */ }
            if (firstWelcome) this.onWelcome();
        }
        if (m.type === 'pong') {
            const rtt = Date.now() - m.time;
            this.ping = Math.round(rtt);
            const offset = m.serverTime - (m.time + rtt / 2);
            this.offset = lerp(this.offset, offset, 0.2);
        }
        if (m.type === 'error') {
            this.clearHandshake();
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
                this.inputs.acknowledge(local.ack);
                this.clearHandshake();
                this.status = 'CONNECTED';
                this.retry = 0;
                const old = this.predicted, replayed = reconcile(local, this.pending, this.round?.phase === 'playing');
                this.pending = replayed.remaining;
                this.seq = Math.max(this.seq, local.ack);
                this.predicted = replayed.predicted;
                if (old && old.life === local.life && old.alive === local.alive) {
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
