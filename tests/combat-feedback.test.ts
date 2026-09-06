import test from 'node:test';
import assert from 'node:assert/strict';
import { Scene } from 'three';
import { CombatClock, traceShot, SWITCH_MS, visibleTargets } from '../src/shared/combat';
import { Room } from '../src/server/simulation';
import { Network } from '../src/client/network';
import { ShotFeedback } from '../src/client/shot-feedback';
import { WeaponPrediction } from '../src/client/weapon-prediction';
import { Effects } from '../src/client/effects';
import { Controls } from '../src/client/input';
import { assertVisibleWeapon } from './viewmodel-fixture';
import { Viewmodel } from '../src/client/viewmodel';
import { UI } from '../src/client/ui';
import type { Renderer } from '../src/client/renderer';
import { moveState, neutralInput, eyeHeight, validInput } from '../src/shared/movement';
import { wireInput, encodeClientMessage, decodeClientMessage, encodeServerMessage, decodeServerMessage } from '../src/shared/protocol';
import { WEAPONS, shotRays } from '../src/shared/weapons';
import type { CombatMessage, Input, WeaponId } from '../src/shared/types';
import { installDOM } from './dom';

function fixture() {
    const room = new Room('COMBAT'); room.botCount = 0;
    const a = room.add('Shooter', 'triggerman', 'blue'), b = room.add('Target', 'triggerman', 'red'); room.start(0);
    Object.assign(a.state, moveState(34, 0, 20), { protectionEnd: 0, yaw: 0, pitch: 0 });
    Object.assign(b.state, moveState(34, 0, 10), { hp: 10000, maxHp: 10000, protectionEnd: 0 });
    return { room, a, b };
}

test('predicted hit is immediate, stays cosmetic, and exact confirmation never replays feedback', () => {
    const { room, a, b } = fixture(), hits: any[] = [], retract: string[] = [];
    let sounds = 0;
    const feedback = new ShotFeedback(new Effects(new Scene()), { fire() {} }, { shot() {}, hit() { sounds++; } });
    feedback.onHit = e => hits.push(e); feedback.onRetract = k => retract.push(k);
    const i = { ...neutralInput(1), fire: true, life: a.state.life };
    feedback.fire({ ...a.state }, i, 0, 0, a.state, [b.state], 'ffa', 1000);
    assert.equal(hits.length, 1); assert.equal(sounds, 1);
    assert.equal(b.state.hp, 10000); assert.equal(a.state.score, 0); assert.equal(hits[0].lethal, false);
    let result!: CombatMessage; room.onCombat = m => { result = m; }; room.fire(a, i, 1000);
    feedback.resolve(result);
    assert.equal(feedback.metrics.disagreements, 0); assert.equal(sounds, 1);
    assert.ok(result.events.filter(e => e.type === 'hit').every(e => feedback.reconcileEvent(e)));
    assert.equal(retract.length, 0);
    const wire = decodeServerMessage(encodeServerMessage(result));
    assert.equal(wire.type, 'combat'); assert.equal(wire.seq, result.seq); assert.equal(wire.time, result.time);
    assert.equal(wire.events.length, result.events.length); assert.deepEqual(wire.players, result.players);
});

test('misses, rejections, wrong victim and head/body differences are counted; old-life results cannot consume a new prediction', () => {
    const { a, b } = fixture(), retract: string[] = [];
    const feedback = new ShotFeedback(new Effects(new Scene()), { fire() {} }, { shot() {} }); feedback.onRetract = k => retract.push(k);
    const input = { ...neutralInput(8), fire: true, life: a.state.life };
    feedback.fire({ ...a.state }, input, 0, 0, a.state, [b.state], 'ffa', 1000);
    const miss: CombatMessage = { type: 'combat', time: 1000, shooter: a.state.id, life: a.state.life - 1, seq: 8, accepted: false, reason: 'expired', events: [], players: [] };
    feedback.resolve(miss); assert.equal(feedback.metrics.compared, 0);
    feedback.resolve({ ...miss, life: a.state.life });
    assert.equal(retract.length, 1); assert.equal(feedback.metrics.disagreementRate, 1); assert.equal(feedback.metrics.rejected, 1);
    feedback.resolve({ ...miss, life: a.state.life }); assert.equal(feedback.metrics.compared, 1);
    feedback.fire({ ...a.state }, { ...input, seq: 9, yaw: Math.PI }, 0, 0, a.state, [b.state], 'ffa', 1000);
    feedback.resolve({ ...miss, accepted: true, life: a.state.life, seq: 9, events: [{ type: 'hit', shooter: a.state.id, victim: b.state.id, damage: 25, zone: 'body', lethal: false, point: b.state, from: a.state }] });
    assert.equal(feedback.metrics.disagreements, 2, 'false negatives count too');
});

test('shared traces respect nearest target, walls, protection, teams, sliding and pellet aggregation', () => {
    const { a, b } = fixture();
    const origin = { x: 34, y: 1, z: 20 }, dir = [{ x: 0, y: 0, z: -1 }];
    const farther = { ...b.state, id: 'farther', z: 5 };
    assert.equal(traceShot('rifle', origin, dir, [farther, b.state]).hits[0].victim, b.state.id);
    assert.equal(traceShot('shotgun', origin, [...dir, ...dir], [b.state]).hits[0].damage, traceShot('shotgun', origin, dir, [b.state]).hits[0].damage * 2);
    assert.equal(visibleTargets(a.state, [{ ...b.state, team: 'blue' }], 'tdm', 1000).length, 0);
    assert.equal(visibleTargets(a.state, [{ ...b.state, protectionEnd: 1500 }], 'ffa', 1000).length, 1);
    assert.equal(traceShot('rifle', { x: 34, y: 1.6, z: 20 }, dir, [{ ...b.state, slide: 1 }]).hits.length, 0);
    assert.equal(traceShot('rifle', { x: -28, y: 1, z: 0 }, [{ x: 1, y: 0, z: 0 }], [{ ...b.state, x: 28, z: 0 }]).hits.length, 0);
});

for (const weapon of Object.keys(WEAPONS) as WeaponId[]) test(`${weapon}: command clock preserves predicted rays, cadence and draw timing through burst delivery`, () => {
    const { room, a, b } = fixture();
    a.state.weapon = weapon; a.state.ammo = 10000; a.ammo[weapon] = 10000;
    const local = { ...a.state }, predictor = new WeaponPrediction();
    let messages: CombatMessage[] = []; room.onCombat = m => messages.push(m);
    let seq = 0, now = 1000, accepted = 0;
    const expected = new Map<number, ReturnType<typeof traceShot>>();
    // Twelve-command coalesced batches mimic recovered upload traffic. Only
    // legitimate elapsed credit permits these commands to run together.
    for (let batch = 0; batch < 20; batch++) {
        const inputs: Input[] = [];
        for (let step = 0; step < 12; step++) {
            const input = wireInput({ ...neutralInput(++seq), combat: true, life: local.life, slot: weapon === 'pistol' ? 2 : weapon === 'knife' ? 3 : 1, aim: true, shotTime: now, interpolationDelay: 0 });
            // For primary-class fixtures retain each weapon as the class primary.
            local.classId = a.state.classId = weapon === 'sniper' ? 'hunter' : weapon === 'shotgun' ? 'vince' : weapon === 'smg' ? 'runngun' : 'triggerman';
            const clock = predictor.preview(local, input), index = clock.fire();
            if (index !== undefined) {
                input.fire = true;
                expected.set(seq, traceShot(weapon, { x: local.x, y: local.y + eyeHeight(local), z: local.z }, shotRays(weapon, 0, 0, 0, clock.bloom, clock.aim, index, seq, local.life), [b.state]));
            }
            predictor.advance(local, input); inputs.push(input);
        }
        a.credit += 12; room.enqueue(a, inputs, now); room.tick(now); now += 200;
    }
    for (const m of messages) {
        assert.equal(m.accepted, true, m.reason);
        const shot = m.events.find(e => e.type === 'shot')!;
        assert.equal(shot.type, 'shot');
        assert.deepEqual(shot.ends, expected.get(m.seq)!.ends); accepted++;
    }
    assert.equal(accepted, expected.size); assert.ok(accepted > 2);
});

test('switch timing cannot be bypassed with sequence gaps, repeated slot keys, or legacy flags', () => {
    const { room, a } = fixture(); let messages: CombatMessage[] = []; room.onCombat = m => messages.push(m);
    for (let step = 0; step < 12; step++) {
        const i = { ...neutralInput(step * 1000 + 1), life: a.state.life, combat: step === 0 ? true : undefined, slot: 2 as const, fire: true, shotTime: 1000 + step * 17 };
        room.enqueue(a, [i], i.shotTime); room.tick(i.shotTime);
    }
    assert.equal(messages.filter(m => m.accepted).length, 1);
    assert.equal(messages.at(-1)!.seq, 11001);
    assert.equal(SWITCH_MS, 180);
    const clock = new CombatClock('rifle'); clock.advance('pistol', neutralInput(), 0);
    assert.equal(clock.fire(), undefined);
});

test('combat input wire extension is lossless, bounded and rejects invalid flags', () => {
    const input = { ...neutralInput(17), combat: true, fire: true, life: 2, interpolationDelay: 700 };
    assert.deepEqual(decodeClientMessage(encodeClientMessage({ type: 'input', inputs: [input] })), { type: 'input', inputs: [input] });
    assert.equal(validInput({ ...input, combat: 12 }), false);
    const bytes = encodeClientMessage({ type: 'input', inputs: [input] }) as Uint8Array;
    bytes[bytes.length - 1] = 3; assert.throws(() => decodeClientMessage(bytes));
});

test('weapon HUD/viewmodel update in the first frame at every render phase; older authority cannot undo a pending selection', t => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const env = installDOM(), net = new Network();
    try {
        const { room, a } = fixture(); net.id = a.state.id; net.predicted = { ...a.state }; net.players.set(net.id, { ...a.state }); net.round = room.round;
        const ui = new UI(net), vm = new Viewmodel(); ui.menu = false;
        const controls = new Controls(document.createElement('canvas')); controls.locked = true;
        const renderer = { viewmodel: vm, project: () => ({ x: 400, y: 300, visible: true }) } as unknown as Renderer;
        for (const rtt of [0, 100, 350]) for (const hz of [60, 144, 240]) for (let phase = 0; phase < 100; phase++) {
            net.ping = rtt;
            const slot = phase % 2 ? 1 : 2;
            document.body.dispatchEvent(new window.KeyboardEvent('keydown', { code: `Digit${slot}`, bubbles: true }));
            net.selectWeapon(controls.slot, ++net.seq);
            const before = { ...a.state, ack: 0 }; net.weapons.reconcile(before, net.predicted!);
            vm.setWeapon(net.predicted!.weapon); vm.update(1 / hz, 0, 0, false, 0, 1000, 0); assertVisibleWeapon(vm); ui.update(1000 + phase * 1000 / hz, renderer, false, []);
            const weapon = slot === 1 ? 'rifle' : 'pistol';
            assert.equal(vm.weapon, weapon); assert.equal(document.getElementById('hud-weapon')!.textContent, WEAPONS[weapon].name);
            assert.equal(document.getElementById('ammo')!.textContent, String(WEAPONS[weapon].magazine));
            assert.equal(document.querySelector('#weapon-slots .active kbd')!.textContent, String(slot));
        }
        let corrected = 0; net.weapons.onCorrection = slot => { corrected = slot; };
        net.selectWeapon(3, ++net.seq);
        net.weapons.confirm({ type: 'weapon', time: 0, life: a.state.life, seq: net.seq, weapon: 'pistol', ammo: 4, reloadEnd: 0 }, net.predicted!);
        assert.equal(net.predicted!.weapon, 'pistol'); assert.equal(net.predicted!.ammo, 4); assert.equal(corrected, 2);
    } finally { net.disconnect(); env.restore(); }
});

test('confirmed death bypasses delayed playback and HUD cadence without changing the interpolated position', t => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const env = installDOM(), net = new Network();
    try {
        const { room, a, b } = fixture(); net.id = a.state.id; net.round = room.round; net.predicted = { ...a.state }; net.players = new Map([[a.state.id, { ...a.state }], [b.state.id, { ...b.state }]]);
        net.frames = [{ time: net.serverNow - 1000, players: new Map(net.players) }, { time: net.serverNow, players: new Map(net.players) }];
        net.ping = 350; net.interpolation.reserve = 500;
        const before = net.remotePlayers()[0];
        const ui = new UI(net), renderer = { viewmodel: { aim: 0 }, project: () => ({ x: 400, y: 300, visible: true }) } as unknown as Renderer;
        ui.update(100, renderer, false); net.onEvents = events => events.forEach(e => ui.event(e, renderer, 101));
        const kill = { type: 'kill' as const, killer: a.state.id, victim: b.state.id, killerName: 'Shooter', victimName: 'Target', weapon: 'rifle' as const, headshot: false, team: 'blue' as const };
        (net as any).receive({ type: 'combat', time: net.serverNow, shooter: a.state.id, life: a.state.life, seq: 1, accepted: true, events: [kill], players: [{ id: b.state.id, life: b.state.life, hp: 0, alive: false }] });
        const after = net.remotePlayers()[0];
        assert.equal(after.alive, false); assert.equal(after.hp, 0); assert.equal(after.z, before.z);
        ui.update(101, renderer, false); assert.match(document.getElementById('killfeed')!.textContent!, /killed/);
        assert.equal(net.predicted!.kills, 0, 'no local score inference from a kill event');
    } finally { net.disconnect(); env.restore(); }
});

test('retracting provisional HUD feedback never changes a newer marker or creates a kill', t => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const env = installDOM(), net = new Network();
    try {
        const { a, b, room } = fixture(); net.id = a.state.id; net.predicted = a.state; net.round = room.round;
        const ui = new UI(net), renderer = { viewmodel: { aim: 0 }, project: () => ({ x: 400, y: 300, visible: true }) } as unknown as Renderer;
        const base = { type: 'hit' as const, shooter: a.state.id, victim: b.state.id, damage: 25, zone: 'body' as const, point: b.state, from: a.state, lethal: false };
        ui.provisionalHit({ ...base, key: 'old' }, renderer, 100);
        const original = document.querySelector('#damage-numbers > span')!;
        ui.provisionalHit({ ...base, key: 'new' }, renderer, 105);
        ui.retractHit('old', 110); ui.update(150, renderer, false, []);
        assert.equal(document.getElementById('hitmarker')!.style.opacity, '1');
        ui.confirmHit('new', { ...base, damage: 12 }); ui.update(191, renderer, false, []);
        assert.equal(original.isConnected, false);
        assert.equal(document.querySelectorAll('#damage-numbers > span').length, 1);
        assert.equal(document.querySelector('#damage-numbers > span')!.textContent, '+12');
        assert.equal(document.getElementById('kill-notice')!.textContent, ''); assert.equal(a.state.kills, 0);
    } finally { net.disconnect(); env.restore(); }
});

test('reload blocks predicted fire through old snapshots and releases only on authoritative completion or switch', () => {
    const { a } = fixture(), weapons = new WeaponPrediction(), p = { ...a.state, ammo: 4 };
    weapons.advance(p, { ...neutralInput(1), combat: true, reload: true, shotTime: 1000 });
    assert.equal(weapons.canFire, false); assert.equal(p.reloadEnd, 2700);
    weapons.reconcile({ ...a.state, ammo: 4, ack: 0 }, p); assert.equal(p.reloadEnd, 2700); assert.equal(weapons.canFire, false);
    weapons.reconcile({ ...a.state, ammo: 4, ack: 1, reloadEnd: 3000 }, p); assert.equal(weapons.canFire, false);
    weapons.reconcile({ ...a.state, ack: 2, reloadEnd: 0 }, p); assert.equal(weapons.canFire, true);
    p.ammo = 4; p.reloadEnd = 0; weapons.advance(p, { ...neutralInput(3), combat: true, reload: true, shotTime: 4000 });
    weapons.select(p, 2, 4); assert.equal(weapons.canFire, true); assert.equal(p.reloadEnd, 0);
    p.ammo = 4; weapons.advance(p, { ...neutralInput(5), slot: 2, combat: true, reload: true, shotTime: 5000 });
    weapons.reconcile({ ...a.state, weapon: 'rifle', ack: 3 }, p);
    assert.equal(p.reloadEnd, 6200, 'an older primary snapshot cannot hide a pending sidearm reload');
});
