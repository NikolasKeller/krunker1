import test from 'node:test';
import assert from 'node:assert/strict';
import { Scene } from 'three';
import { Room } from './sandyard-room';
import { RemoteHealth } from '../src/client/remote-health';
import { Network } from '../src/client/network';
import { ShotFeedback, type ProvisionalHit } from '../src/client/shot-feedback';
import { Effects } from '../src/client/effects';
import { UI } from '../src/client/ui';
import type { Renderer } from '../src/client/renderer';
import { moveState, neutralInput } from '../src/shared/movement';
import type { CombatMessage } from '../src/shared/types';
import { installDOM } from './dom';

function fixture() {
    const room = new Room('HEALTH'); room.botCount = 0;
    const a = room.add('You', 'triggerman', 'blue').state, b = room.add('Target', 'triggerman', 'red').state;
    room.start(0);
    Object.assign(a, moveState(34, 0, 20), { protectionEnd: 0 });
    Object.assign(b, moveState(34, 0, 10), { protectionEnd: 0 });
    const players = new Map([[a.id, a], [b.id, b]]), health = new RemoteHealth();
    health.snapshot(players, a, 0, 0);
    const hit = (seq: number, damage = 25): ProvisionalHit => ({ type: 'hit', key: `${a.life}:${seq}:${b.id}`, shooter: a.id, victim: b.id, damage, zone: 'body', point: b, from: a, lethal: false });
    const confirm = (seq: number, hp: number, accepted = true) => {
        b.hp = hp;
        const m: CombatMessage = { type: 'combat', shooter: a.id, life: a.life, seq, time: seq * 100, accepted, events: accepted ? [hit(seq)] : [], players: accepted ? [{ id: b.id, life: b.life, hp }] : [] };
        health.resolve(m, players, a.id, seq * 100); return m;
    };
    return { a, b, room, players, health, hit, confirm, sample: (now = 0) => health.sample({ ...b }, now) };
}

test('several predicted decrements accumulate in the current sample; confirmations never double-count', () => {
    const { a, b, players, health, hit, confirm, sample } = fixture();
    const drawn = sample();
    health.predict(hit(1), players, 0); assert.equal(drawn.hp, 75);
    health.predict(hit(2), players, 0); assert.equal(drawn.hp, 50);
    health.predict(hit(2), players, 0); assert.equal(drawn.hp, 50, 'duplicate prediction is idempotent');
    assert.equal(b.hp, 100); assert.equal(b.alive, true); assert.equal(a.kills, 0);
    const first = confirm(1, 75); assert.equal(sample(100).hp, 50);
    health.resolve(first, players, a.id, 101); assert.equal(sample(101).hp, 50);
    health.snapshot(players, { ...a, ack: 1 }, 150, 150); assert.equal(sample(150).hp, 50);
    confirm(2, 50); assert.equal(sample(200).hp, 50);
    health.snapshot(players, { ...a, ack: 2 }, 250, 250); assert.equal(sample(250).hp, 50);
});

test('snapshot ACK retires covered predictions; a late confirmation cannot subtract them again', () => {
    const { a, b, players, health, hit, sample } = fixture();
    health.predict(hit(1), players, 0); health.predict(hit(2), players, 0);
    b.hp = 75;
    health.snapshot(players, { ...a, ack: 1 }, 500, 500); assert.equal(sample(500).hp, 50);
    health.resolve({ type: 'combat', shooter: a.id, life: a.life, seq: 1, time: 400, accepted: true, events: [hit(1)], players: [{ id: b.id, life: b.life, hp: 75 }] }, players, a.id, 501);
    assert.equal(sample(501).hp, 50);
    b.hp = 50; health.snapshot(players, { ...a, ack: 2 }, 550, 550); assert.equal(sample(550).hp, 50);
});

test('rejected and differently sized hits ease to authority; new damage remains immediate during reconciliation', () => {
    const { b, players, health, hit, confirm, sample } = fixture();
    health.predict(hit(1), players, 0); health.predict(hit(2), players, 0);
    assert.equal(sample(100).hp, 50);
    confirm(1, 100, false); assert.equal(sample(100).hp, 50, 'rejection cannot snap the bar');
    const eased = sample(116).hp; assert.ok(eased > 50 && eased < 55);
    health.predict(hit(3, 10), players, 116);
    assert.equal(sample(116).hp, eased - 10, 'new hit subtracts exactly its damage from the visible bar');
    confirm(2, 80); assert.equal(sample(200).alive, true);
    confirm(3, 70);
    const settled = sample(2000); assert.equal(settled.hp, 70); assert.equal(b.hp, 70);
});

test('other players damage bypasses playback, prediction can empty the bar but only authority kills', () => {
    const { a, b, players, health, hit, sample } = fixture();
    const drawn = sample(); health.predict(hit(1), players, 0);
    b.hp = 80;
    health.resolve({ type: 'combat', shooter: 'someone-else', life: 1, seq: 1, time: 50, accepted: true, events: [], players: [{ id: b.id, life: b.life, hp: 80 }] }, players, a.id, 50);
    assert.equal(drawn.hp, 55);
    health.predict(hit(2, 100), players, 50);
    assert.equal(drawn.hp, 0); assert.equal(drawn.alive, true); assert.equal(b.hp, 80); assert.equal(a.kills, 0);
    b.hp = 0; b.alive = false; health.snapshot(players, a, 100, 100);
    assert.equal(sample(100).alive, false); assert.equal(sample(100).hp, 0);
});

test('expired predictions retract quietly; respawn, removal and session reset discard old health debt', () => {
    const { a, b, players, health, hit, sample } = fixture();
    health.predict(hit(1), players, 0); assert.equal(sample().hp, 75);
    health.retract(hit(1).key); assert.equal(sample().hp, 75); assert.equal(sample(2000).hp, 100);
    health.predict(hit(2), players, 2000); b.life++;
    health.snapshot(players, a, 3000, 3000); assert.equal(sample(3000).hp, 100);
    health.retract(hit(2).key); assert.equal(sample(3000).hp, 100);
    health.predict(hit(3), players, 3000); players.delete(b.id); health.snapshot(players, a, 3100, 3100);
    players.set(b.id, b); assert.equal(sample(3200).hp, 100);
    health.predict(hit(4), players, 3200); health.reset(); assert.equal(sample(3300).hp, 100);
});

test('real shot feedback changes the health-bar DOM and yellow number in the firing frame without resampling motion', t => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const env = installDOM(), net = new Network();
    try {
        const { a, b, room, players } = fixture();
        net.id = a.id; net.players = players; net.round = room.round; net.predicted = { ...a };
        net.frames = [{ time: net.serverNow - 1000, players: new Map(players) }, { time: net.serverNow, players: new Map(players) }];
        net.ping = 350; net.interpolation.reserve = 1500;
        const ui = new UI(net); ui.menu = false;
        const renderer = { fps: 60, viewmodel: { aim: 0 }, project: (p: { z: number }) => ({ x: 400, y: p.z * 10, visible: true }) } as unknown as Renderer;
        const shots = new ShotFeedback(new Effects(new Scene()), { fire() {} }, { shot() {} });
        shots.onHit = e => { net.remoteHealth.predict(e, net.players, performance.now()); ui.provisionalHit(e, renderer, 100); };
        const remotes = net.remotePlayers(), position = remotes[0].z;
        ui.update(100, renderer, false, remotes);
        assert.equal(document.querySelector<HTMLElement>('.nameplate b')!.style.width, '100%');
        shots.fire({ ...a }, { ...neutralInput(1), life: a.life, fire: true }, 0, 0, a, remotes, 'ffa', 1000);
        assert.equal(remotes[0].z, position);
        ui.update(100, renderer, false, remotes);
        const damage = Number(document.querySelector('#damage-numbers > span')!.textContent!.slice(1));
        assert.ok(damage > 0);
        assert.equal(parseFloat(document.querySelector<HTMLElement>('.nameplate b')!.style.width), 100 - damage);
        assert.equal(remotes[0].hp, 100 - damage); assert.equal(b.hp, 100); assert.equal(b.alive, true);
    } finally { net.disconnect(); env.restore(); }
});
