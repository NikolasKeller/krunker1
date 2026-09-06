import assert from 'node:assert/strict';
import test from 'node:test';
import { Room, MAX_QUEUED_SHOT_AGE_MS } from '../src/server/simulation';
import { rewindTime } from '../src/server/history';
import { MAX_REWIND_MS, MAX_INTERPOLATION_DELAY_MS } from '../src/shared/types';
import { moveState, neutralInput, validInput } from '../src/shared/movement';
import { decodeClientMessage, encodeClientMessage, wireInput } from '../src/shared/protocol';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { createGameServer } from '../src/server/index';
import { Network } from '../src/client/network';

test('shot timing survives binary batching without changing the movement floats', () => {
    const inputs = [wireInput({ ...neutralInput(1), life: 1, fire: true, shotTime: 1780000000123.25, interpolationDelay: 678.123456, forward: .2 }), { ...neutralInput(2), life: 1 }];
    const wire = encodeClientMessage({ type: 'input', inputs }); assert.ok(wire instanceof Uint8Array);
    assert.deepEqual(decodeClientMessage(wire), { type: 'input', inputs });
    for (let n = 0; n < wire.length; n++) assert.throws(() => decodeClientMessage(wire.slice(0, n)));
    for (const interpolationDelay of [-1, NaN, Infinity, MAX_INTERPOLATION_DELAY_MS + 1]) {
        assert.equal(validInput({ ...neutralInput(1), interpolationDelay }), false);
    }
});

test('rewind includes actual playback delay and upload time with a hard historical ceiling', () => {
    const now = 10000;
    assert.equal(rewindTime(now - 850, now, 350, 675), now - 850);
    assert.equal(rewindTime(now - 850, now, 350), now - 250, 'legacy timing remains conservative');
    assert.equal(rewindTime(now + 1000, now, 350, 675), now);
    assert.equal(rewindTime(0, now, 1e9, 1e9), now - MAX_REWIND_MS);
    assert.equal(rewindTime(0, now, 0, 1e9), now - MAX_INTERPOLATION_DELAY_MS - 150);
});

test('a recent shot with a delayed render timestamp is not mistaken for a queued old shot', () => {
    const room = new Room('TIMING'); room.botCount = 0;
    const a = room.add('Shooter', 'triggerman', 'blue'), b = room.add('Target', 'triggerman', 'red'); room.start(0);
    Object.assign(a.state, moveState(34, 0, 20));
    Object.assign(b.state, moveState(34, 0, 10), { protectionEnd: 0 });
    a.rtt = 500; a.aimTime = 1;
    room.history.record(2800, [a.state, b.state]); room.history.record(3000, [a.state, b.state]);
    const input = { ...neutralInput(1), aim: true, fire: true, shotTime: 2850, interpolationDelay: 900 };
    assert.ok(4000 - input.shotTime > MAX_QUEUED_SHOT_AGE_MS);
    room.enqueue(a, [input], 4000); room.tick(4000);
    assert.ok(room.events.some(e => e.type === 'hit' && e.victim === b.state.id));
});

test('four-second-old fire expires explicitly while its movement is still acknowledged', () => {
    const room = new Room('EXPIRED'); room.botCount = 0;
    const a = room.add('Shooter', 'triggerman', 'blue'); room.start(0);
    Object.assign(a.state, moveState(34, 0, 20));
    const ammo = a.state.ammo;
    room.enqueue(a, [{ ...neutralInput(1), forward: 1, fire: true, shotTime: 325, interpolationDelay: 675 }], 5000);
    room.tick(5000);
    assert.equal(a.state.ack, 1); assert.ok(a.state.z < 20);
    assert.equal(a.state.ammo, ammo); assert.ok(!room.events.some(e => e.type === 'shot'));
    assert.equal(room.shotRejections.get(a.state.id)?.reason, 'expired');
    assert.equal(room.shotRejections.get(a.state.id)?.seq, 1);
    room.enqueue(a, [{ ...neutralInput(2), fire: true, shotTime: 4960, interpolationDelay: 100 }], 5060); room.tick(5060);
    assert.ok(room.events.some(e => e.type === 'shot'), 'fresh fire is not delayed by an expired input');
});

test('a claimed fresh shot cannot select a target beyond the retained historical ceiling', () => {
    const room = new Room('CEILING'); room.botCount = 0;
    const a = room.add('Shooter', 'triggerman', 'blue'); room.start(0);
    room.enqueue(a, [{ ...neutralInput(1), fire: true, shotTime: 5000 - MAX_REWIND_MS - 1, interpolationDelay: MAX_INTERPOLATION_DELAY_MS }], 5000);
    room.tick(5000);
    assert.ok(!room.events.some(e => e.type === 'shot'));
    assert.equal(room.shotRejections.get(a.state.id)?.reason, 'expired');
});

test('a real four-second upload stall reports expired fire to its sender and accepts fresh fire after recovery', async t => {
    const app = createGameServer();
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address(); assert.ok(address && typeof address === 'object');
    for (const [key, value] of Object.entries({ WebSocket, location: new URL(`http://127.0.0.1:${address.port}`), sessionStorage: { getItem: () => null, setItem() {} } })) {
        const previous = Object.getOwnPropertyDescriptor(globalThis, key);
        Object.defineProperty(globalThis, key, { configurable: true, value });
        t.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else Reflect.deleteProperty(globalThis, key); });
    }
    const clients = [new Network(), new Network()], notices: string[][] = [[], []];
    clients.forEach((n, i) => { n.onNotice = text => notices[i].push(text); });
    const wait = async (fn: () => unknown) => {
        const deadline = Date.now() + 6000;
        while (!fn()) { assert.ok(Date.now() < deadline, 'socket response timed out'); await delay(10); }
    };
    try {
        const [shooter, observer] = clients;
        shooter.connect({ name: 'Stalled', room: '', create: true, classId: 'triggerman', team: 'blue' });
        await wait(() => shooter.local);
        const room = app.rooms.get(shooter.room)!; room.botCount = 0; room.fillBots(Date.now());
        observer.connect({ name: 'Observer', room: shooter.room, classId: 'triggerman', team: 'red' });
        await wait(() => observer.local);
        room.start(Date.now());
        await wait(() => clients.every(n => n.round?.phase === 'playing'));
        const ws = shooter.ws!, transmit = ws.send.bind(ws), uploads: Parameters<typeof ws.send>[0][] = [];
        ws.send = data => { uploads.push(data); };
        const timing = shooter.shotTiming(shooter.serverNow - 675);
        shooter.input({ ...neutralInput(++shooter.seq), fire: true, forward: 1, ...timing });
        const beforeAmmo = room.players.get(shooter.id)!.state.ammo;
        await delay(4000);
        ws.send = transmit; for (const data of uploads) transmit(data);
        await wait(() => notices[0].length && shooter.local!.ack === shooter.seq);
        assert.deepEqual(notices, [['Shot expired during connection delay. Fire again.'], []]);
        assert.equal(room.players.get(shooter.id)!.state.ammo, beforeAmmo);
        assert.equal(shooter.maxCorrection, 0);
        let confirmed = false;
        shooter.onEvents = events => { if (events.some(e => e.type === 'shot' && e.shooter === shooter.id)) confirmed = true; };
        shooter.input({ ...neutralInput(++shooter.seq), fire: true, ...shooter.shotTiming(shooter.serverNow - 100) });
        await wait(() => confirmed);
        assert.equal(room.players.get(shooter.id)!.state.ammo, beforeAmmo - 1);
    } finally { clients.forEach(n => n.disconnect()); await app.close(); }
});
