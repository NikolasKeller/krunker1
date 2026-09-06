import { MAX_INTERPOLATION_DELAY_MS, type ClientMessage, type GameEvent, type Input, type PlayerState, type RoundState, type ServerMessage, type ClassId, type Team, type Difficulty } from '../shared/types';
import { correctedPosition, predictInput, PredictionHistory, preserveLocalMotion, smoothCorrection } from './prediction';
import { RemoteInterpolation } from './interpolation';
import { RemoteHealth } from './remote-health';
import { clamp, lerp } from '../shared/math';
import { decodeServerMessage, encodeClientMessage, INPUT_SEND_MS, WIRE_PROTOCOL } from '../shared/protocol';
import { WeaponPrediction } from './weapon-prediction';
import { InputBuffer } from '../shared/input-buffer';
export const JOIN_RETRY_MS = 2000;
export const CONNECT_TIMEOUT_MS = 30000;
export const SLOW_CONNECTION_MS = 5000;
export const CONNECTION_DEAD_MS = 45000;
export const RECONNECT_BASE_MS = 1000;
export const RECONNECT_MAX_MS = 30000;
export function retryDelay(attempt: number, base = RECONNECT_BASE_MS, cap = RECONNECT_MAX_MS) {
    return Math.min(cap, base * 2 ** Math.min(attempt, 10)) * (0.75 + Math.random() * 0.25);
}
export class Network {
    readonly weapons = new WeaponPrediction();
    onCombat: (message: Extract<ServerMessage, { type: 'combat' }>) => void = () => {};
    combatDelays: number[] = [];
    selectWeapon(slot: Input['slot'], seq = this.seq + 1, _time = performance.now()) {
        return !!this.predicted && this.round?.phase === 'playing' && this.weapons.select(this.predicted, slot, seq);
    }
    ws?: WebSocket;
    id = '';
    room = '';
    host = '';
    status = 'CREATE OR JOIN A LOBBY';
    ping = 0;
    offset = 0;
    private clockSamples: { now: number; rtt: number }[] = [];
    seq = 0;
    players = new Map<string, PlayerState>();
    predicted?: PlayerState;
    round?: RoundState;
    difficulty: Difficulty = 'normal';
    bots = 5;
    readonly inputs = new InputBuffer();
    readonly predictionHistory = new PredictionHistory();
    get pending() { return this.inputs.pending; }
    set pending(value: Input[]) { this.inputs.pending = value; }
    get outgoing() { return this.inputs.outgoing; }
    set outgoing(value: Input[]) { this.inputs.outgoing = value; }
    readonly interpolation = new RemoteInterpolation();
    readonly remoteHealth = new RemoteHealth();
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
    correctionDistances: number[] = [];
    rawCorrectionDistances: number[] = [];
    maxRawCorrection = 0;
    movementMeasuredAt = 0;
    renderedCorrectionDistances: number[] = [];
    maxRenderedCorrection = 0;
    maxFrameCorrection = 0;
    private retry = 0;
    private generation = 0;
    private reconnectTimer?: ReturnType<typeof setTimeout>;
    private handshakeTimer?: ReturnType<typeof setTimeout>;
    private joinTimer?: ReturnType<typeof setTimeout>;
    private reconnect?: () => void;
    private lastMessageAt = 0;
    private lastSyncAt = 0;
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
        const now = Date.now();
        if (this.ws?.readyState !== WebSocket.OPEN) return;
        // TCP may be stalled for seconds. Avoid adding probes to a blocked write
        // queue; any valid server message proves the transport is still alive.
        if (!this.ws.bufferedAmount) this.send({ type: 'ping', time: now });
        if (!this.local) return; // The generous handshake timer owns admission.
        if (now - this.lastMessageAt >= CONNECTION_DEAD_MS) {
            this.reconnect?.();
        } else if (now - this.receivedAt >= SLOW_CONNECTION_MS) {
            this.status = 'CONNECTION SLOW';
            if (!this.ws.bufferedAmount && now - this.lastSyncAt >= SLOW_CONNECTION_MS) {
                this.send({ type: 'sync' });
                this.lastSyncAt = now;
            }
        }
    }, 1500); }
    private clearHandshake() {
        clearTimeout(this.handshakeTimer);
        clearTimeout(this.joinTimer);
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
        this.status = this.retry ? 'RECONNECTING' : 'CONNECTING';
        this.id = '';
        this.host = '';
        this.seq = 0;
        this.round = undefined;
        this.receivedAt = 0;
        this.lastMessageAt = Date.now();
        this.lastSyncAt = 0;
        this.players.clear();
        this.weapons.reset(); this.combatDelays = [];
        this.frames = [];
        this.interpolation.reset();
        this.remoteHealth.reset();
        this.clockSamples = [];
        this.predicted = undefined;
        this.inputs.clear();
        this.predictionHistory.clear();
        this.correction = { x: 0, y: 0, z: 0 };
        this.correctionDistances = []; this.rawCorrectionDistances = []; this.renderedCorrectionDistances = [];
        this.reconciliations = this.maxCorrection = this.maxRawCorrection = this.maxRenderedCorrection = this.maxFrameCorrection = 0;
        this.movementMeasuredAt = performance.now();
        this.lastSnapshot = 0;
        const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`, WIRE_PROTOCOL);
        ws.binaryType = 'arraybuffer';
        this.ws = ws;
        clearInterval(this.inputTimer);
        this.inputTimer = setInterval(() => this.flush(), INPUT_SEND_MS);
        const reconnect = this.reconnect = () => {
            if (generation !== this.generation) return;
            ++this.generation;
            this.clearHandshake();
            this.status = 'RECONNECTING';
            ws.close();
            this.reconnectTimer = setTimeout(() => this.connect(config), retryDelay(this.retry++));
        };
        this.handshakeTimer = setTimeout(reconnect, CONNECT_TIMEOUT_MS);
        ws.onopen = () => {
            if (generation !== this.generation) return;
            this.status = this.retry ? 'REJOINING LOBBY' : 'JOINING LOBBY';
            let token = this.tokens.get(config.room);
            // Storage is optional: a privacy policy must not prevent the join from being sent.
            try { token ??= sessionStorage.getItem(`arena-token-${config.room}`) ?? undefined; } catch { /* Use the in-memory token. */ }
            const join: ClientMessage = { type: 'join', ...config, token };
            let joinAttempt = 0;
            const requestLobby = () => {
                if (generation !== this.generation || this.local) return;
                if (!ws.bufferedAmount) this.send(this.id ? { type: 'sync' } : join);
                this.joinTimer = setTimeout(requestLobby, retryDelay(joinAttempt++, JOIN_RETRY_MS, 12000));
            };
            requestLobby();
            this.send({ type: 'ping', time: Date.now() });
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
        // Browsers emit close after an error. Only close/the watchdog schedules a
        // retry, so late error callbacks cannot flicker an established session.
        ws.onerror = () => {};
    }
    send(message: ClientMessage) { if (this.ws?.readyState === WebSocket.OPEN)
        this.ws.send(encodeClientMessage(message)); }
    get serverNow() { return Date.now() + this.offset; }
    get interpolationDelay() { return this.interpolation.delay(this.ping); }
    shotTiming(shotTime = this.interpolation.playbackTime ?? this.serverNow - this.interpolationDelay) {
        // Playback converges gradually when jitter changes. Its actual age, not
        // just the desired reserve, is the timestamp's matching rewind budget.
        return { shotTime, interpolationDelay: clamp(this.serverNow - shotTime, 0, MAX_INTERPOLATION_DELAY_MS) };
    }
    get local() { return this.players.get(this.id); }
    input(input: Input) {
        if (!this.predicted) return;
        const timing = input.interpolationDelay === undefined ? this.shotTiming(input.shotTime) : {};
        const i = this.inputs.enqueue({ ...input, ...timing, life: this.predicted.life });
        this.predictionHistory.add(i);
        if (this.round?.phase === 'playing') this.weapons.advance(this.predicted, i);
        predictInput(this.predicted, i, this.round?.phase === 'playing');
    }
    smoothCorrection(dt: number) {
        const distance = smoothCorrection(this.correction, dt);
        this.maxFrameCorrection = Math.max(this.maxFrameCorrection, distance);
        return distance;
    }
    get movementMetrics() {
        const distribution = (values: number[]) => {
            const sorted = [...values].sort((a, b) => a - b);
            return { p50: sorted[Math.floor((sorted.length - 1) * .5)] ?? 0, p95: sorted[Math.floor((sorted.length - 1) * .95)] ?? 0 };
        };
        const seconds = (performance.now() - this.movementMeasuredAt) / 1000;
        return { seconds, retainedSamples: this.correctionDistances.length, percentileWindowSeconds: 1200,
            rawMetres: { ...distribution(this.rawCorrectionDistances), max: this.maxRawCorrection },
            appliedMetres: { ...distribution(this.correctionDistances), max: this.maxCorrection },
            renderedSnapshotMetres: { ...distribution(this.renderedCorrectionDistances), max: this.maxRenderedCorrection },
            visibleThresholdMetres: .01, correctionsPerSecond: this.reconciliations / Math.max(seconds, .001),
            maxFrameCorrectionMetres: this.maxFrameCorrection, droppedInputs: this.inputs.dropped };
    }
    flush() { if (this.ws) this.inputs.flush(this.ws); }
    private receive(m: ServerMessage) {
        this.lastMessageAt = Date.now();
        // Legacy room chat packets are intentionally ignored by this client.
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
            const now = performance.now();
            this.clockSamples.push({ now, rtt });
            while (this.clockSamples.length > 256 || now - this.clockSamples[0].now > 60000) this.clockSamples.shift();
            const floor = Math.min(...this.clockSamples.map(s => s.rtt));
            // A stalled downlink delays the pong, not the server clock. Using
            // those asymmetric samples under-reported playback age by hundreds
            // of ms and made the server clamp otherwise valid aimed shots.
            if (rtt <= floor + 25) this.offset = lerp(this.offset, offset, 0.2);
        }
        if (m.type === 'error') {
            this.clearHandshake();
            this.status = m.message;
            this.onNotice(m.message);
        }
        if (m.type === 'shot-rejected') this.onNotice('Shot expired during connection delay. Fire again.');
        if (m.type === 'weapon' && this.predicted) this.weapons.confirm(m, this.predicted);
        if (m.type === 'combat') {
            this.combatDelays.push(this.serverNow - m.time);
            if (this.combatDelays.length > 24000) this.combatDelays.shift();
            // Living movement and ACKs stay on the snapshot channel. Death
            // carries its freeze pose; provisional feedback never writes here.
            for (const patch of m.players) {
                const p = this.players.get(patch.id);
                if (!p || p.life !== patch.life) continue;
                Object.assign(p, patch);
                if (patch.id === this.id && this.predicted?.life === patch.life) Object.assign(this.predicted, patch);
            }
            this.remoteHealth.resolve(m, this.players, this.id, performance.now());
            this.onCombat(m);
            this.onEvents(m.events);
        }
        if (m.type === 'events')
            this.onEvents(m.events);
        if (m.type === 'snapshot') {
            if (!m.full && m.base !== this.lastSnapshot) {
                this.send({ type: 'sync' });
                return;
            }
            this.receivedAt = Date.now();
            this.interpolation.observe(m.time, performance.now());
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
            while (this.frames.length > 64)
                this.frames.shift();
            const local = this.local;
            this.remoteHealth.snapshot(this.players, local, m.time, performance.now());
            if (local) {
                this.inputs.acknowledge(local.ack);
                this.clearHandshake();
                this.status = 'CONNECTED';
                this.retry = 0;
                const old = this.predicted;
                const oldView = old && correctedPosition(old, this.correction);
                this.pending = this.pending.filter(i => i.seq > local.ack);
                this.seq = Math.max(this.seq, local.ack);
                this.predicted = this.predictionHistory.reconcile(local, this.round?.phase === 'playing', old);
                this.weapons.reconcile(local, this.predicted);
                if (old && old.life === local.life && old.alive === local.alive) {
                    if (!this.movementMeasuredAt) this.movementMeasuredAt = performance.now();
                    const raw = Math.hypot(old.x - this.predicted.x, old.y - this.predicted.y, old.z - this.predicted.z);
                    this.maxRawCorrection = Math.max(this.maxRawCorrection, raw);
                    this.rawCorrectionDistances.push(raw);
                    if (this.rawCorrectionDistances.length > 24000) this.rawCorrectionDistances.shift();
                    preserveLocalMotion(old, this.predicted);
                    const dx = old.x - this.predicted.x, dy = old.y - this.predicted.y, dz = old.z - this.predicted.z;
                    const error = Math.hypot(dx, dy, dz);
                    this.maxCorrection = Math.max(this.maxCorrection, error);
                    this.correctionDistances.push(error);
                    if (this.correctionDistances.length > 24000) this.correctionDistances.shift();
                    if (error > 0.01)
                        this.reconciliations++;
                    this.correction.x += dx;
                    this.correction.y += dy;
                    this.correction.z += dz;
                    const view = correctedPosition(this.predicted, this.correction);
                    const rendered = Math.hypot(oldView!.x - view.x, oldView!.y - view.y, oldView!.z - view.z);
                    this.maxRenderedCorrection = Math.max(this.maxRenderedCorrection, rendered);
                    this.renderedCorrectionDistances.push(rendered);
                    if (this.renderedCorrectionDistances.length > 24000) this.renderedCorrectionDistances.shift();
                }
                else {
                    this.pending = [];
                    this.outgoing = [];
                    this.predictionHistory.clear();
                    this.correction = { x: 0, y: 0, z: 0 };
                }
            }
        }
    }
    remotePlayers(): PlayerState[] {
        return this.interpolation.sample(this.frames, this.id, this.serverNow, performance.now(), this.ping).map(p => {
            const latest = this.players.get(p.id);
            // Position uses playback history; health and life transitions use the
            // latest authority. Never replay a dead opponent as alive.
            if (!latest) return p;
            const state = latest.life !== p.life ? { ...latest } : { ...p, alive: latest.alive, hp: latest.hp, protectionEnd: latest.protectionEnd };
            return this.remoteHealth.sample(state, performance.now());
        });
    }
}
