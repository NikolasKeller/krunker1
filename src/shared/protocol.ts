import type { ClientMessage, GameEvent, Input, PlayerPatch, PlayerState, ServerMessage } from './types';

// Control/lobby messages stay JSON. Versioned binary frames carry the frequent traffic.
export const WIRE_PROTOCOL = 'arena-v4';
export const LEGACY_WIRE_PROTOCOL = 'arena-v2';
export const INPUT_RATE = 20;
export const INPUT_SEND_MS = 1000 / INPUT_RATE;
export const MAX_INPUT_BATCH = 12;
// Ten seconds of movement history; packets still contain at most 200 ms and
// are sent at 20 Hz. A four-second outage must not erase locally applied steps.
export const MAX_PENDING_INPUTS = 600;
export const MAX_IN_FLIGHT_INPUTS = 360;
export const MAX_CLIENT_PAYLOAD = 4096;
const INPUT = 1, SNAPSHOT = 2, EVENTS = 3, COMBAT_INPUT = 4, COMBAT = 5;
const utf8 = new TextEncoder(), text = new TextDecoder('utf-8', { fatal: true });
type WireData = string | ArrayBuffer | ArrayBufferView;
class Writer {
    buffer = new ArrayBuffer(512);
    view = new DataView(this.buffer);
    offset = 0;
    reserve(bytes: number) {
        if (this.offset + bytes <= this.buffer.byteLength) return;
        const grown = new ArrayBuffer(Math.max(this.buffer.byteLength * 2, this.offset + bytes));
        new Uint8Array(grown).set(new Uint8Array(this.buffer));
        this.buffer = grown; this.view = new DataView(grown);
    }
    u8(v: number) { this.reserve(1); this.view.setUint8(this.offset++, v); }
    u32(v: number) { this.reserve(4); this.view.setUint32(this.offset, v, true); this.offset += 4; }
    f32(v: number) { this.reserve(4); this.view.setFloat32(this.offset, v, true); this.offset += 4; }
    f64(v: number) { this.reserve(8); this.view.setFloat64(this.offset, v, true); this.offset += 8; }
    string(v: string) {
        const bytes = utf8.encode(v);
        if (bytes.length > 65535) throw new Error('String too long');
        this.reserve(2 + bytes.length);
        this.view.setUint16(this.offset, bytes.length, true); this.offset += 2;
        new Uint8Array(this.buffer, this.offset, bytes.length).set(bytes); this.offset += bytes.length;
    }
    finish() { return new Uint8Array(this.buffer.slice(0, this.offset)); }
}
class Reader {
    view: DataView;
    offset = 0;
    constructor(data: Exclude<WireData, string>) {
        this.view = data instanceof ArrayBuffer ? new DataView(data) : new DataView(data.buffer, data.byteOffset, data.byteLength);
    }
    u8() { return this.view.getUint8(this.offset++); }
    u32() { const v = this.view.getUint32(this.offset, true); this.offset += 4; return v; }
    f32() { const v = this.view.getFloat32(this.offset, true); this.offset += 4; return v; }
    f64() { const v = this.view.getFloat64(this.offset, true); this.offset += 8; return v; }
    string() {
        const n = this.view.getUint16(this.offset, true); this.offset += 2;
        if (this.offset + n > this.view.byteLength) throw new Error('Truncated string');
        const v = text.decode(new Uint8Array(this.view.buffer, this.view.byteOffset + this.offset, n)); this.offset += n; return v;
    }
    done() { if (this.offset !== this.view.byteLength) throw new Error('Trailing data'); }
}
const boolFields = new Set<keyof PlayerState>(['bot', 'ready', 'grounded', 'slideHeld', 'jumpHeld', 'alive', 'aiming']);
const stringFields = new Set<keyof PlayerState>(['name', 'classId', 'team', 'weapon']);
const integerFields = new Set<keyof PlayerState>(['ack', 'life', 'kills', 'deaths', 'score', 'streak']);
const timeFields = new Set<keyof PlayerState>(['reloadEnd', 'respawnAt', 'protectionEnd']);
// Append-only field order is part of arena-v2. Two presence masks preserve sparse deltas.
const fields = ['name', 'classId', 'team', 'bot', 'ready', 'x', 'y', 'z', 'vx', 'vy', 'vz', 'grounded', 'slide', 'slideHeld', 'jumpHeld', 'groundTime', 'jumpBuffer', 'coyote', 'slideAge', 'yaw', 'pitch', 'hp', 'maxHp', 'alive', 'kills', 'deaths', 'score', 'weapon', 'ammo', 'reloadEnd', 'respawnAt', 'protectionEnd', 'ack', 'aiming', 'bloom', 'streak', 'life'] as const;
function writePlayer(w: Writer, p: PlayerPatch, precise: boolean) {
    w.string(p.id);
    for (let start = 0; start < fields.length; start += 32) {
        let mask = start === 32 && precise ? 0x80000000 : 0;
        for (let k = start; k < Math.min(start + 32, fields.length); k++) if (p[fields[k]] !== undefined) mask |= 1 << (k - start);
        w.u32(mask);
    }
    for (const key of fields) {
        const v = p[key]; if (v === undefined) continue;
        if (boolFields.has(key)) w.u8(v ? 1 : 0);
        else if (stringFields.has(key)) w.string(v as string);
        else if (integerFields.has(key)) w.u32(v as number);
        else if (timeFields.has(key) || precise) w.f64(v as number);
        else w.f32(v as number);
    }
}
function readPlayer(r: Reader): PlayerPatch {
    const p: Record<string, unknown> = { id: r.string() }, masks = [r.u32(), r.u32()];
    for (let k = 0; k < fields.length; k++) {
        if (!(masks[k >>> 5] & (1 << (k % 32)))) continue;
        const key = fields[k];
        p[key] = boolFields.has(key) ? !!r.u8() : stringFields.has(key) ? r.string() : integerFields.has(key) ? r.u32() : (timeFields.has(key) || (masks[1] & 0x80000000)) ? r.f64() : r.f32();
    }
    return p as PlayerPatch;
}
const vec = (w: Writer, p: { x: number; y: number; z: number }) => { w.f32(p.x); w.f32(p.y); w.f32(p.z); };
const readVec = (r: Reader) => ({ x: r.f32(), y: r.f32(), z: r.f32() });
function writeEvent(w: Writer, e: GameEvent) {
    if (e.type === 'shot') {
        w.u8(0); w.string(e.shooter); w.string(e.weapon); w.u32(e.seq); vec(w, e.origin); w.u8(e.ends.length); for (const p of e.ends) vec(w, p);
    } else if (e.type === 'hit') {
        w.u8(1); w.string(e.shooter); w.string(e.victim); w.f32(e.damage); w.string(e.zone); vec(w, e.point); vec(w, e.from); w.u8(e.lethal ? 1 : 0);
    } else if (e.type === 'kill') {
        w.u8(2); w.string(e.killer); w.string(e.victim); w.string(e.killerName); w.string(e.victimName); w.string(e.weapon); w.u8(e.headshot ? 1 : 0); w.string(e.team);
    } else { w.u8(3); w.string(e.text); }
}
function readEvent(r: Reader): GameEvent {
    switch (r.u8()) {
        case 0: {
            const shooter = r.string(), weapon = r.string() as Extract<GameEvent, { type: 'shot' }>['weapon'], seq = r.u32(), origin = readVec(r);
            return { type: 'shot', shooter, weapon, seq, origin, ends: Array.from({ length: r.u8() }, () => readVec(r)) };
        }
        case 1: return { type: 'hit', shooter: r.string(), victim: r.string(), damage: r.f32(), zone: r.string() as 'head' | 'body' | 'legs', point: readVec(r), from: readVec(r), lethal: !!r.u8() };
        case 2: return { type: 'kill', killer: r.string(), victim: r.string(), killerName: r.string(), victimName: r.string(), weapon: r.string() as Extract<GameEvent, { type: 'kill' }>['weapon'], headshot: !!r.u8(), team: r.string() as 'blue' | 'red' };
        case 3: return { type: 'notice', text: r.string() };
        default: throw new Error('Invalid event');
    }
}
export function encodeClientMessage(m: ClientMessage): string | Uint8Array {
    if (m.type !== 'input') return JSON.stringify(m);
    if (!m.inputs.length || m.inputs.length > MAX_INPUT_BATCH) throw new Error('Invalid input batch');
    const modern = m.inputs.some(i => i.combat !== undefined);
    const w = new Writer(); w.u8(modern ? COMBAT_INPUT : INPUT); w.u8(m.inputs.length);
    for (const i of m.inputs) {
        w.u32(i.seq); w.u32(i.life ?? 0xffffffff); w.f32(i.forward); w.f32(i.strafe); w.f32(i.yaw); w.f32(i.pitch); w.f64(i.shotTime);
        w.u8(+i.jump | +i.slide << 1 | +i.fire << 2 | +i.aim << 3 | +i.reload << 4 | (i.slot - 1) << 5 | +(i.interpolationDelay !== undefined) << 7);
        if (i.interpolationDelay !== undefined) w.f32(i.interpolationDelay);
        if (modern) w.u8(i.combat === undefined ? 0 : i.combat ? 2 : 1);
    }
    return w.finish();
}
export function decodeClientMessage(data: WireData): ClientMessage {
    if (typeof data === 'string') return JSON.parse(data);
    const r = new Reader(data);
    const kind = r.u8();
    if (kind !== INPUT && kind !== COMBAT_INPUT) throw new Error('Invalid client frame');
    const count = r.u8();
    if (!count || count > MAX_INPUT_BATCH) throw new Error('Invalid input batch');
    const inputs: Input[] = [];
    for (let n = 0; n < count; n++) {
        const seq = r.u32(), life = r.u32(), forward = r.f32(), strafe = r.f32(), yaw = r.f32(), pitch = r.f32(), shotTime = r.f64(), flags = r.u8();
        if ((flags >> 5 & 3) === 3) throw new Error('Invalid input flags');
        const timing = flags & 128 ? { interpolationDelay: r.f32() } : {};
        const combat = kind === COMBAT_INPUT ? r.u8() : 0;
        if (combat > 2) throw new Error('Invalid combat flag');
        inputs.push({ ...(combat ? { combat: combat === 2 } : {}), seq, life: life === 0xffffffff ? undefined : life, forward, strafe, yaw, pitch: Math.abs(pitch) === Math.fround(Math.PI / 2) ? Math.sign(pitch) * Math.PI / 2 : pitch, shotTime, ...timing, jump: !!(flags & 1), slide: !!(flags & 2), fire: !!(flags & 4), aim: !!(flags & 8), reload: !!(flags & 16), slot: ((flags >> 5 & 3) + 1) as 1 | 2 | 3 });
    }
    r.done(); return { type: 'input', inputs };
}
export function encodeServerMessage(m: ServerMessage, selfId?: string): string | Uint8Array {
    if (m.type !== 'snapshot' && m.type !== 'events' && m.type !== 'combat') return JSON.stringify(m);
    const w = new Writer();
    if (m.type === 'combat') {
        w.u8(COMBAT); w.f64(m.time); w.string(m.shooter); w.u32(m.life); w.u32(m.seq); w.u8(+m.accepted); w.string(m.reason ?? '');
        w.u8(m.players.length); for (const p of m.players) writePlayer(w, p, p.id === selfId);
        w.u32(m.events.length); for (const e of m.events) writeEvent(w, e);
    } else if (m.type === 'snapshot') {
        w.u8(SNAPSHOT); w.u32(m.n); w.u32(m.base); w.f64(m.time); w.u8(+m.full); w.u8(m.players.length);
        for (const p of m.players) writePlayer(w, p, p.id === selfId);
        w.u8(m.removed.length); for (const id of m.removed) w.string(id);
        // Infrequent round/lobby metadata includes results and arbitrary player names.
        const { round, host, difficulty, bots, selectionAck } = m;
        w.string(round || host !== undefined || difficulty || bots !== undefined || selectionAck !== undefined ? JSON.stringify({ round, host, difficulty, bots, selectionAck }) : '');
    } else {
        w.u8(EVENTS); w.u32(m.events.length); for (const e of m.events) writeEvent(w, e);
    }
    return w.finish();
}
export function decodeServerMessage(data: WireData): ServerMessage {
    if (typeof data === 'string') return JSON.parse(data);
    const r = new Reader(data), type = r.u8();
    let m: ServerMessage;
    if (type === SNAPSHOT) {
        const n = r.u32(), base = r.u32(), time = r.f64(), full = !!r.u8(), players = Array.from({ length: r.u8() }, () => readPlayer(r));
        const removed = Array.from({ length: r.u8() }, () => r.string()), metadata = r.string();
        m = { type: 'snapshot', n, base, time, full, players, removed, ...(metadata ? JSON.parse(metadata) : {}) };
    } else if (type === EVENTS) {
        const count = r.u32(); if (count > 4096) throw new Error('Too many events');
        m = { type: 'events', events: Array.from({ length: count }, () => readEvent(r)) };
    } else if (type === COMBAT) {
        const time = r.f64(), shooter = r.string(), life = r.u32(), seq = r.u32(), accepted = !!r.u8();
        const reason = r.string() as Extract<ServerMessage, { type: 'combat' }>['reason'];
        const players = Array.from({ length: r.u8() }, () => readPlayer(r));
        const count = r.u32(); if (count > 4096) throw new Error('Too many combat events');
        m = { type: 'combat', time, shooter, life, seq, accepted, ...(reason ? { reason } : {}), players, events: Array.from({ length: count }, () => readEvent(r)) };
    } else throw new Error('Invalid server frame');
    r.done(); return m;
}
// Prediction uses exactly the floats sent over the wire.
export function wireInput(i: Input): Input {
    return { ...i, ...(i.interpolationDelay !== undefined ? { interpolationDelay: Math.fround(i.interpolationDelay) } : {}), forward: Math.fround(i.forward), strafe: Math.fround(i.strafe), yaw: Math.fround(i.yaw), pitch: Math.max(-Math.PI / 2, Math.min(Math.PI / 2, Math.fround(i.pitch))) };
}
