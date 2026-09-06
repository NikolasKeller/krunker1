import { test } from 'node:test';
import assert from 'node:assert/strict';
import { direction, hitPlayer, rayBox, rayRamp, worldHit } from '../src/shared/math';
import { damageFor, recoilFor, shotDirections, spreadFor, WEAPONS } from '../src/shared/weapons';
import { MAX_SPEED, move, moveState, neutralInput, validInput } from '../src/shared/movement';
import { STEP, type PlayerState } from '../src/shared/types';
import { BOXES, RAMPS, SPAWNS } from '../src/shared/map';
import { History, rewindTime } from '../src/server/history';
import { checkRound, newRound, startRound } from '../src/server/round';
import { Room } from '../src/server/simulation';
import { findPath } from '../src/server/bots';
const almost = (actual: number, expected: number, e = 1e-5) => assert.ok(Math.abs(actual - expected) < e, `${actual} ≠ ${expected}`);
function room() { const r = new Room('TEST'); r.botCount = 0; return r; }
function player(): PlayerState { return room().add('Test', 'triggerman', 'blue').state; }
test('ray box handles forward hits, behind-origin misses, parallel axes and inside origin', () => {
    const min = { x: -1, y: 0, z: -10 }, max = { x: 1, y: 2, z: -8 };
    assert.equal(rayBox({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, min, max), 8);
    assert.equal(rayBox({ x: 2, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, min, max), null);
    assert.equal(rayBox({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }, min, max), null);
    assert.equal(rayBox({ x: 0, y: 1, z: -9 }, { x: 0, y: 0, z: -1 }, min, max), 0);
});
test('head, torso, legs and sliding hitboxes match their vertical bounds', () => {
    const p = { x: 0, y: 0, z: -10, slide: 0 }, d = { x: 0, y: 0, z: -1 };
    assert.equal(hitPlayer({ x: 0, y: 1.6, z: 0 }, d, p)?.zone, 'head');
    assert.equal(hitPlayer({ x: 0, y: 1, z: 0 }, d, p)?.zone, 'body');
    assert.equal(hitPlayer({ x: 0, y: .3, z: 0 }, d, p)?.zone, 'legs');
    assert.equal(hitPlayer({ x: 0, y: 2, z: 0 }, d, p), null);
    assert.equal(hitPlayer({ x: 0, y: 1.6, z: 0 }, d, { ...p, slide: 0.5 }), null);
    assert.equal(hitPlayer({ x: 0, y: 1.1, z: 0 }, d, { ...p, slide: 0.5 })?.zone, 'head');
});
test('ramps block bullets through their solid volume without blocking above the slope', () => {
    const r = RAMPS[0];
    const down = { x: 0, y: -1, z: 0 };
    almost(rayRamp({ x: -10, y: 10, z: 0 }, down, r)!, 8);
    assert.equal(rayRamp({ x: -10, y: 5, z: -8 }, { x: 0, y: 0, z: 1 }, r), null);
    assert.ok(rayRamp({ x: -10, y: 1, z: -8 }, { x: 0, y: 0, z: 1 }, r)! < 8);
});
test('world collision blocks the sightline through a building', () => { assert.ok(worldHit({ x: -19, y: 1.5, z: 0 }, { x: 0, y: 0, z: -1 }, 40) < 7); });
test('weapon damage preserves the former Hunter ratios at 100 HP', () => {
    assert.equal(damageFor('sniper', 'body', 30), 184);
    assert.equal(damageFor('sniper', 'head', 30), 276);
    assert.equal(damageFor('sniper', 'legs', 30), 101);
    assert.equal(damageFor('rifle', 'head', 10), 63);
    assert.equal(damageFor('rifle', 'body', 10), 42);
    assert.equal(damageFor('smg', 'head', 10), 45);
});
test('shotgun close-range pellets are lethal and fall off sharply', () => {
    assert.equal(damageFor('shotgun', 'body', 4) * 8, 320);
    assert.ok(damageFor('shotgun', 'body', 26) * 8 < 25);
    assert.equal(damageFor('shotgun', 'body', 40), 0);
});
test('spread increases with speed and firing, decreases with ADS, and is deterministic by seed', () => {
    assert.ok(spreadFor('rifle', 10, 0, 0) > spreadFor('rifle', 0, 0, 0));
    assert.ok(spreadFor('rifle', 0, .02, 0) > spreadFor('rifle', 0, 0, 0));
    assert.ok(spreadFor('sniper', 12, 0, 1) < .001);
    const a = shotDirections('shotgun', .5, .2, .07, 123), b = shotDirections('shotgun', .5, .2, .07, 123);
    assert.deepEqual(a, b);
    assert.equal(a.length, 8);
    for (const d of a)
        almost(Math.hypot(d.x, d.y, d.z), 1);
    assert.notDeepEqual(a, shotDirections('shotgun', .5, .2, .07, 124));
});
test('recoil pattern cycles, differs by weapon and stays bounded', () => { assert.deepEqual(recoilFor('rifle', 0), recoilFor('rifle', WEAPONS.rifle.recoil.length)); assert.notDeepEqual(recoilFor('smg', 0), recoilFor('sniper', 0)); for (let i = 0; i < 100; i++) {
    const r = recoilFor('smg', i);
    assert.ok(Math.abs(r[0]) < .05 && Math.abs(r[1]) < .05);
} });
test('input validation rejects NaN, impossible speed, wrong buttons and invalid sequences', () => {
    const i = neutralInput(1);
    assert.equal(validInput(i), true);
    for (const bad of [{ forward: 2 }, { strafe: -4 }, { yaw: Infinity }, { pitch: NaN }, { pitch: 2 }, { seq: -1 }, { seq: .5 }, { slot: 4 }, { fire: 1 }, { shotTime: NaN }])
        assert.equal(validInput({ ...i, ...bad }), false, JSON.stringify(bad));
    assert.equal(validInput(null), false);
});
test('movement is deterministic for prediction replay and achieves arcade running speed', () => {
    // x=32 runs into the crate at (31,27); a speed check needs a clear lane.
    const p = moveState(34, 0, 30), q = { ...p }, i = { ...neutralInput(1), forward: 1 };
    for (let n = 0; n < 60; n++) {
        move(p, i);
        move(q, i);
    }
    assert.deepEqual(p, q);
    assert.ok(Math.hypot(p.vx, p.vz) > 10.5);
    assert.ok(p.z < 21);
});
test('jump launches promptly, has no midair second jump, and lands without fall damage state', () => {
    const p = moveState(32, 0, 20), i = { ...neutralInput(1), jump: true };
    move(p, i);
    assert.ok(p.y > 0 && p.vy > 8);
    for (let n = 0; n < 5; n++)
        move(p, i);
    const vy = p.vy;
    move(p, { ...i, jump: false });
    move(p, i);
    assert.ok(p.vy < vy);
    for (let n = 0; n < 100; n++)
        move(p, { ...i, jump: false });
    almost(p.y, 0);
    assert.equal(p.grounded, true);
});
test('timed landing slide and bunny hop preserve and increase speed', () => {
    const p = moveState(32, 0, 25);
    Object.assign(p, { vx: 0, vz: -14, groundTime: 0, slideAge: 1 });
    const i = { ...neutralInput(1), forward: 1, slide: true };
    move(p, i);
    assert.ok(p.slide > 0);
    const sliding = Math.hypot(p.vx, p.vz);
    assert.ok(sliding > 15.5);
    move(p, { ...i, slide: false, jump: true });
    assert.ok(Math.hypot(p.vx, p.vz) > sliding);
    assert.ok(p.vy > 8);
});
test('late jump is slower than precisely timed hop and holding jump does not auto-jump', () => {
    const late = moveState(32, 0, 25), timed = moveState(32, 0, 25);
    Object.assign(late, { vz: -15, groundTime: .5 });
    Object.assign(timed, { vz: -15, groundTime: 0 });
    const i = { ...neutralInput(), forward: 1, jump: true };
    move(late, i);
    move(timed, i);
    assert.ok(Math.hypot(timed.vx, timed.vz) > Math.hypot(late.vx, late.vz));
    for (let n = 0; n < 100; n++)
        move(late, i);
    assert.equal(late.grounded, true);
});
test('movement clamps velocity and prevents walking through walls', () => {
    const p = moveState(32, 0, 20);
    Object.assign(p, { vx: 10000, vz: 10000 });
    move(p, neutralInput());
    assert.ok(Math.hypot(p.vx, p.vz) <= MAX_SPEED + 0.01);
    const q = moveState(-19, 0, 0);
    for (let n = 0; n < 120; n++)
        move(q, { ...neutralInput(), forward: 1 });
    assert.ok(q.z > -6);
    assert.ok(q.z < -5.5);
});
test('ramps are walkable to the elevated central platform', () => {
    const p = moveState(-17, 0, 2.5), i = { ...neutralInput(), forward: 1, yaw: -Math.PI / 2 };
    let maxY = 0;
    for (let n = 0; n < 100; n++) {
        move(p, i);
        maxY = Math.max(maxY, p.y);
    }
    assert.ok(maxY >= 3.9, `ramp height reached ${maxY}`);
});
test('spawns never overlap a solid obstacle', () => { for (const p of SPAWNS)
    for (const b of BOXES)
        assert.ok(!(Math.abs(p.x - b.x) < b.w / 2 + .38 && Math.abs(p.z - b.z) < b.d / 2 + .38 && p.y < b.y + b.h / 2), `spawn ${p.x},${p.z}`); });
test('rewind interpolates between history frames and clamps outside history', () => {
    const h = new History(), p = player();
    p.x = 0;
    h.record(1000, [p]);
    p.x = 10;
    h.record(1100, [p]);
    almost(h.rewind(p.id, 1050)!.x, 5);
    almost(h.rewind(p.id, 800)!.x, 0);
    almost(h.rewind(p.id, 1200)!.x, 10);
    assert.equal(h.rewind('missing', 1000), null);
});
test('rewind cannot blend a dead player into a new life', () => { const h = new History(), p = player(); p.x = 0; h.record(1000, [p]); p.life++; p.x = 30; h.record(1100, [p]); const q = h.rewind(p.id, 1050)!; assert.equal(q.x, 0); assert.notEqual(q.life, p.life); });
test('client timestamps cannot force future or unbounded rewinds', () => { assert.equal(rewindTime(5000, 1000, 0), 1000); assert.equal(rewindTime(0, 1000, 0), 850); assert.equal(rewindTime(0, 1000, 1000), 750); assert.equal(rewindTime(900, 1000, 50), 900); });
test('round transitions from lobby through time/score limits into results', () => {
    const r = newRound();
    assert.equal(r.phase, 'lobby');
    startRound(r, 1000);
    assert.equal(r.phase, 'playing');
    const p = player();
    assert.equal(checkRound(r, [p], 2000), false);
    p.kills = 25;
    p.name = 'Winner';
    assert.equal(checkRound(r, [p], 2100), true);
    assert.equal(r.winner, 'Winner');
    assert.equal(r.nextAt, 8100);
    assert.equal(checkRound(r, [p], 2200), false);
    startRound(r, 15000);
    assert.equal(r.round, 2);
    assert.equal(checkRound(r, [], r.endsAt), true);
});
test('team round winner uses team kills and handles a tie', () => { const r = newRound('tdm'); startRound(r, 0); r.blue = 25; assert.ok(checkRound(r, [], 100)); assert.equal(r.winner, 'BLUE TEAM'); startRound(r, 200); r.blue = 3; r.red = 3; checkRound(r, [], r.endsAt); assert.equal(r.winner, 'DRAW'); });
test('server ignores movement results and rejects invalid or replayed input sequences', () => {
    const r = room(), a = r.add('A', 'triggerman', 'blue');
    r.start(1000);
    assert.equal(r.enqueue(a, [{ ...neutralInput(1), x: 99999 }], 1000), true);
    r.tick(1017);
    assert.notEqual(a.state.x, 99999);
    assert.equal(r.enqueue(a, [neutralInput(1)], 1018), false);
    assert.equal(r.enqueue(a, [{ ...neutralInput(2), forward: 20 }], 1019), false);
});
test('input flooding cannot simulate more than the tick budget', () => { const r = room(), a = r.add('A', 'triggerman', 'blue'); r.start(1000); Object.assign(a.state, moveState(32, 0, 30)); for (let batch = 0; batch < 6; batch++)
    r.enqueue(a, Array.from({ length: 10 }, (_, i) => ({ ...neutralInput(batch * 10 + i + 1), forward: 1 })), 1000); r.tick(1017); assert.ok(a.state.ack <= 3); assert.ok(30 - a.state.z < .15); });
test('server fire cadence and reload duration are authoritative', () => {
    const r = room(), a = r.add('A', 'triggerman', 'blue');
    r.start(1000);
    a.state.protectionEnd = 0;
    let seq = 0;
    for (let n = 0; n < 60; n++) {
        r.enqueue(a, [{ ...neutralInput(++seq), fire: true, shotTime: 1300 + n * STEP * 1000 }], 1300 + n * STEP * 1000);
        r.tick(1300 + n * STEP * 1000);
    }
    const shots = 30 - a.state.ammo;
    assert.ok(shots >= 7 && shots <= 9, `${shots} shots in 1 second`);
    const remaining = a.state.ammo;
    r.enqueue(a, [{ ...neutralInput(++seq), reload: true }], 2400);
    r.tick(2400);
    assert.equal(a.state.reloadEnd, 4100);
    r.tick(4000);
    assert.equal(a.state.ammo, remaining);
    r.tick(4101);
    assert.equal(a.state.ammo, 30);
});
test('server validates headshots, spawn protection, friendly fire and wall occlusion', () => {
    for (const condition of ['head', 'protection', 'team', 'wall']) {
        const r = room(), a = r.add('Shooter', 'hunter', 'blue'), b = r.add('Target', 'triggerman', condition === 'team' ? 'blue' : 'red');
        r.start(1000);
        r.round.mode = condition === 'team' ? 'tdm' : 'ffa';
        Object.assign(a.state, moveState(32, 0, 15), { yaw: 0, pitch: 0, protectionEnd: 0 });
        Object.assign(b.state, moveState(32, 0, 0), { protectionEnd: condition === 'protection' ? 5000 : 0 });
        if (condition === 'wall') {
            a.state.x = -19;
            a.state.z = 0;
            b.state.x = -19;
            b.state.z = -25;
        }
        a.aimTime = 1;
        a.nextShot = 0;
        r.history.record(2000, [a.state, b.state]);
        r.fire(a, { ...neutralInput(1), shotTime: 2000 }, 2000);
        assert.equal(b.state.alive, condition !== 'head' && condition !== 'protection', condition);
        if (condition === 'head') {
            assert.equal(a.state.kills, 1);
            assert.ok(r.events.some(e => e.type === 'hit' && e.zone === 'head'));
        }
    }
});
test('respawn resets health, ammo and momentum without immunity', () => { const r = room(), a = r.add('A', 'hunter', 'blue'); r.start(1000); Object.assign(a.state, { alive: false, hp: 0, respawnAt: 2000, vx: 20, ammo: 0 }); r.tick(2001); assert.equal(a.state.hp, 100); assert.equal(a.state.ammo, 3); assert.equal(a.state.vx, 0); assert.equal(a.state.protectionEnd, 0); });
test('bots fill requested slots and paths route around buildings', () => { const r = room(); r.add('Human', 'hunter', 'blue'); r.botCount = 5; r.fillBots(0); assert.equal(r.players.size, 6); r.botCount = 2; r.fillBots(0); assert.equal(r.players.size, 3); const path = findPath({ x: -30, y: 0, z: -30 }, { x: -10, y: 0, z: 5 }); assert.ok(path.length > 4); for (const p of path)
    for (const b of BOXES)
        assert.ok(!(Math.abs(p.x - b.x) < b.w / 2 && Math.abs(p.z - b.z) < b.d / 2 && b.y - b.h / 2 < p.y + 1.85 && b.y + b.h / 2 > p.y + .05)); });
test('prediction reconciles from an older acknowledgement and replays only pending inputs', async () => {
    const { predictInput, reconcile } = await import('../src/client/prediction');
    const start = player();
    Object.assign(start, moveState(32, 0, 30));
    const predicted = { ...start }, authoritative = { ...start };
    const inputs = Array.from({ length: 60 }, (_, i) => ({ ...neutralInput(i + 1), forward: 1, jump: i === 15, slide: i > 47 && i < 51 }));
    for (const input of inputs)
        predictInput(predicted, input, true);
    for (const input of inputs.slice(0, 30))
        predictInput(authoritative, input, true);
    authoritative.ack = 30;
    const result = reconcile(authoritative, inputs, true);
    assert.equal(result.remaining.length, 30);
    almost(result.predicted.x, predicted.x);
    almost(result.predicted.y, predicted.y);
    almost(result.predicted.z, predicted.z);
    almost(result.predicted.vz, predicted.vz);
});
test('a class change applies immediately without healing', () => { const r = room(), a = r.add('A', 'triggerman', 'blue'); r.start(0); a.state.hp = 40; r.changeClass(a, 'hunter', 1000); assert.equal(a.state.classId, 'hunter'); assert.equal(a.state.hp, 40); assert.equal(a.state.maxHp, 100); assert.equal(a.state.weapon, 'sniper'); });
test('the bridge underpass connects the side lanes without a dead end', () => { const p = moveState(-9, 0, -9), i = { ...neutralInput(), forward: 1, yaw: -Math.PI / 2 }; for (let n = 0; n < 100; n++)
    move(p, i); assert.ok(p.x > 7, `underpass exit x=${p.x}`); assert.equal(p.y, 0); });

test('switching rooms clears stale input sequences; a resumed snapshot restores its acknowledgement', async () => {
    const { Network } = await import('../src/client/network');
    class Socket {
        static OPEN = 1;
        static latest: Socket;
        readyState = 1;
        sent: string[] = [];
        onopen?: () => void;
        onmessage?: (event: { data: string }) => void;
        constructor() { Socket.latest = this; }
        close() {}
        send(data: string) { this.sent.push(data); }
    }
    const keys = ['WebSocket', 'location', 'sessionStorage', 'setInterval'] as const;
    const descriptors = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
    const values = [Socket, { protocol: 'http:', host: 'localhost:5173' }, { getItem: () => null, setItem() {} }, () => 0];
    keys.forEach((key, i) => Object.defineProperty(globalThis, key, { configurable: true, value: values[i] }));
    try {
        const n = new Network();
        n.seq = 20000; n.id = 'old';
        n.connect({ name: 'A', room: 'NEW', classId: 'hunter', team: 'blue' });
        assert.equal(n.seq, 0); assert.equal(n.id, '');
        Socket.latest.onopen?.();
        const p = player(); p.ack = 700;
        Socket.latest.onmessage?.({ data: JSON.stringify({ type: 'welcome', id: p.id, room: 'NEW', token: 'token', host: p.id, serverTime: Date.now() }) });
        Socket.latest.onmessage?.({ data: JSON.stringify({ type: 'snapshot', n: 1, base: 0, time: Date.now(), full: true, players: [p], removed: [], round: newRound(), host: p.id, difficulty: 'normal', bots: 0 }) });
        assert.equal(n.seq, 700); assert.equal(n.local?.id, p.id);
        Socket.latest.onmessage?.({ data: JSON.stringify({ type: 'snapshot', n: 2, base: 1, time: Date.now(), full: false, players: [{ id: p.id, x: p.x + 1 }], removed: [] }) });
        assert.equal(n.round?.phase, 'lobby', 'unchanged room metadata survives sparse snapshots');
        assert.equal(n.host, p.id); assert.equal(n.bots, 0); assert.equal(n.local?.x, p.x + 1);
        Socket.latest.onmessage?.({ data: JSON.stringify({ type: 'snapshot', n: 4, base: 3, full: false }) });
        assert.ok(Socket.latest.sent.some(s => JSON.parse(s).type === 'sync'));
    } finally {
        keys.forEach((key, i) => { const descriptor = descriptors[i]; if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); });
    }
});

test('bot navigation reaches the raised deck through a ramp while retaining the underpass', () => {
    const up = findPath({ x: -20, y: 0, z: 0 }, { x: 3, y: 4, z: -8 });
    assert.ok(up.some(p => p.y > 0 && p.y < 4), 'uses a ramp');
    assert.equal(up.at(-1)?.y, 4, 'reaches upper deck');
    const below = findPath({ x: -10, y: 0, z: -9 }, { x: 10, y: 0, z: -9 });
    assert.ok(below.length > 0);
    assert.ok(below.every(p => p.y === 0), 'uses ground-level underpass');
});
test('ten teammates spawn at distinct safe locations instead of stacking', () => {
    const r = room(); r.round.mode = 'tdm';
    const team = Array.from({ length: 10 }, (_, i) => r.add(`Player ${i}`, 'triggerman', 'blue'));
    r.start(1000);
    for (let i = 0; i < team.length; i++) for (let j = i + 1; j < team.length; j++) {
        const a = team[i].state, b = team[j].state;
        assert.ok(Math.hypot(a.x - b.x, a.z - b.z) >= 2);
    }
});

test('bot ramp waypoints can actually be followed by shared movement', () => {
    const p = moveState(-20, 0, 0);
    const path = findPath(p, { x: 3, y: 4, z: -8 });
    let waypoint = 0;
    for (let step = 0; step < 1800 && waypoint < path.length; step++) {
        const target = path[waypoint];
        if (Math.hypot(target.x - p.x, target.z - p.z, target.y - p.y) < .45) { waypoint++; continue; }
        const input = neutralInput(step);
        input.yaw = Math.atan2(-(target.x - p.x), -(target.z - p.z)); input.forward = .8;
        move(p, input, 9);
    }
    assert.equal(waypoint, path.length, 'ramp navigation remains compatible with collision');
    assert.ok(p.y > 3.9);
});

test('delayed inputs from a previous life are acknowledged without moving or firing after respawn', () => {
    const r = room(), a = r.add('Delayed', 'triggerman', 'blue'); r.start(1000);
    const oldLife = a.state.life; r.spawn(a, 2000);
    const origin = { x: a.state.x, z: a.state.z };
    const delayed = { ...neutralInput(1), life: oldLife, forward: 1, fire: true };
    assert.ok(r.enqueue(a, [delayed], 2500)); r.tick(2500);
    assert.equal(a.state.ack, 1); assert.equal(a.state.x, origin.x); assert.equal(a.state.z, origin.z);
    assert.equal(r.events.some(e => e.type === 'shot'), false);
    assert.ok(r.enqueue(a, [{ ...delayed, seq: 2, life: a.state.life, shotTime: 2517 }], 2517)); r.tick(2517);
    assert.ok(r.events.some(e => e.type === 'shot'));
});

test('jittered 20 Hz input packets recover without accumulating a server backlog', () => {
    const r = room(), a = r.add('Jitter', 'triggerman', 'blue'); r.start(1000);
    let seq = 0, lastDelivery = 0, nextDelivery = 3, worstQueue = 0;
    for (let tick = 1; tick <= 600; tick++) {
        if (tick === nextDelivery) {
            const inputs = Array.from({ length: tick - lastDelivery }, () => neutralInput(++seq));
            assert.ok(r.enqueue(a, inputs, 1000 + tick * STEP * 1000));
            lastDelivery = tick; nextDelivery += tick % 12 === 3 ? 9 : 3;
        }
        r.tick(1000 + tick * STEP * 1000);
        worstQueue = Math.max(worstQueue, a.queue.length);
    }
    assert.ok(worstQueue <= 6, `burst is drained, maximum queued steps: ${worstQueue}`);
    assert.ok(seq - a.state.ack <= 6);
});

test('dropped input sequence gaps recover while movement remains limited by server time', () => {
    const r = room(), a = r.add('Reconnect', 'triggerman', 'blue'); r.start(1000);
    Object.assign(a.state, moveState(32, 0, 30));
    assert.ok(r.enqueue(a, [{ ...neutralInput(10000), forward: 1 }], 1017));
    r.tick(1017);
    assert.equal(a.state.ack, 10000);
    assert.ok(30 - a.state.z < .15, 'sequence gaps cannot fast-forward simulation');
    assert.equal(r.enqueue(a, [neutralInput(10001), { ...neutralInput(10002), forward: 99 }], 1034), false);
    assert.equal(a.lastSeq, 10000, 'invalid batch is rejected atomically');
    assert.equal(a.queue.length, 0);
});

test('a stalled TCP stream replays every retained movement step within its banked tick budget', () => {
    const r = room(), a = r.add('Burst', 'triggerman', 'blue'); r.start(1000);
    for (let tick = 1; tick <= 60; tick++) r.tick(1000 + tick * STEP * 1000);
    for (let batch = 0; batch < 6; batch++)
        assert.ok(r.enqueue(a, Array.from({ length: 10 }, (_, n) => neutralInput(batch * 10 + n + 1)), 2001));
    r.tick(2017);
    assert.equal(a.queue.length, 48, 'unprocessed movement remains queued');
    r.tick(2034);
    assert.equal(a.state.ack, 24, 'acknowledgements cannot skip locally applied movement');
    for (let tick = 0; tick < 15; tick++) r.tick(2051 + tick * STEP * 1000);
    assert.equal(a.state.ack, 60); assert.equal(a.queue.length, 0);
});


test('respawn acknowledges received inputs discarded with the previous life', () => {
    const r = room(), a = r.add('Generation', 'hunter', 'blue'); r.start(1000);
    assert.ok(r.enqueue(a, [neutralInput(1), neutralInput(2), neutralInput(3)], 1001));
    r.spawn(a, 1002);
    assert.equal(a.queue.length, 0);
    assert.equal(a.state.ack, 3, 'the client can release transmission credit for discarded commands');
});
