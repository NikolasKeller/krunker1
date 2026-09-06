import assert from 'node:assert/strict';
import test from 'node:test';
import { Room } from './sandyard-room';
import { WeaponPrediction } from '../src/client/weapon-prediction';
import { neutralInput } from '../src/shared/movement';
import { WEAPONS } from '../src/shared/weapons';
import type { Input } from '../src/shared/types';
function fixture() {
    const room = new Room('RELOAD'); room.botCount = 0;
    const actor = room.add('You', 'triggerman', 'blue'); room.start(0);
    actor.state.ammo = actor.ammo.rifle = 1;
    return { room, actor, p: { ...actor.state }, weapons: new WeaponPrediction() };
}
const input = (seq: number, time: number, extra: Partial<Input> = {}): Input => ({ ...neutralInput(seq), combat: true, shotTime: time, interpolationDelay: 0, ...extra });
test('last round immediately starts predicted and authoritative reload, with no repeated fire request', () => {
    const { room, actor, p, weapons } = fixture();
    const shot = input(1, 1000, { fire: true, life: p.life });
    weapons.predictShot(p, shot);
    assert.equal(p.ammo, 0); assert.equal(p.reloadEnd, 1000 + WEAPONS.rifle.reload);
    assert.equal(weapons.canFire, false);
    weapons.advance(p, shot); assert.equal(p.ammo, 0, 'the fixed step cannot deduct the same shot twice');
    room.enqueue(actor, [shot], 1000); room.tick(1000);
    assert.equal(actor.state.ammo, 0); assert.equal(actor.state.reloadEnd, p.reloadEnd);
    assert.equal(room.events.filter(e => e.type === 'shot').length, 1);
    weapons.reconcile({ ...actor.state, ack: 0, ammo: 1, reloadEnd: 0 }, p);
    assert.equal(p.ammo, 0); assert.equal(p.reloadEnd, 2700, 'older snapshots cannot hide the predicted reload');
    for (const [seq, time] of [[2, 1100], [3, 1800], [4, 2699]]) {
        const r = input(seq, time, { reload: true });
        weapons.advance(p, r); room.enqueue(actor, [r], time); room.tick(time);
        assert.equal(p.reloadEnd, 2700); assert.equal(actor.state.reloadEnd, 2700);
    }
    room.tick(2700); assert.equal(actor.state.ammo, 30); assert.equal(actor.state.reloadEnd, 0);
    assert.equal(weapons.canFire, false, 'elapsed client time does not grant ammunition');
    weapons.reconcile(actor.state, p); assert.equal(p.ammo, 30); assert.equal(weapons.canFire, true);
});
test('switch cancels an automatic reload and preserves the shared draw delay', () => {
    const { room, actor, p, weapons } = fixture();
    const shot = input(1, 1000, { fire: true }); weapons.advance(p, shot); room.enqueue(actor, [shot], 1000); room.tick(1000);
    weapons.select(p, 2, 2); assert.equal(p.reloadEnd, 0); assert.equal(p.ammo, WEAPONS.pistol.magazine);
    let accepted = 0; room.onCombat = m => { if (m.accepted) accepted++; };
    for (let step = 0; step < 12; step++) {
        const command = input(2 + step, 1020 + step * 17, { slot: 2, fire: true });
        weapons.advance(p, command); room.enqueue(actor, [command], command.shotTime); room.tick(command.shotTime);
        if (step < 11) assert.equal(accepted, 0, 'auto reload cancellation cannot bypass weapon draw');
        assert.equal(actor.state.reloadEnd, 0);
    }
    assert.equal(accepted, 1); assert.equal(p.ammo, 9);
    weapons.select(p, 1, 20); assert.equal(p.ammo, 0); assert.equal(p.reloadEnd, 0, 'switching back does not resurrect the old reload');
});
test('manual reload still starts a partial magazine, cannot fire during reload, and rejects quietly', () => {
    const { p, weapons } = fixture(); p.ammo = 12;
    weapons.advance(p, input(1, 1000, { reload: true }));
    assert.equal(p.reloadEnd, 2700);
    weapons.advance(p, input(2, 1200, { fire: true })); assert.equal(p.ammo, 12);
    weapons.reconcile({ ...p, ack: 2, reloadEnd: 0 }, p); assert.equal(weapons.canFire, true);
    weapons.predictShot(p, input(3, 1300, { fire: true })); assert.equal(p.ammo, 11);
    weapons.reconcile({ ...p, ack: 3, ammo: 12 }, p); assert.equal(p.ammo, 12);
});
test('lobby, countdown, results, death and old-life inputs cannot start an automatic reload', () => {
    for (const phase of ['lobby', 'countdown', 'results'] as const) {
        const { room, actor } = fixture(); room.round.phase = phase; room.round.nextAt = 10000;
        room.enqueue(actor, [input(1, 1000, { fire: true })], 1000); room.tick(1000);
        assert.equal(actor.state.ammo, 1); assert.equal(actor.state.reloadEnd, 0);
    }
    const { room, actor, p, weapons } = fixture();
    p.alive = actor.state.alive = false; actor.state.respawnAt = 10000;
    weapons.advance(p, input(1, 1000, { fire: true }));
    room.enqueue(actor, [input(1, 1000, { fire: true })], 1000); room.tick(1000);
    assert.equal(p.ammo, 1); assert.equal(p.reloadEnd, 0); assert.equal(actor.state.reloadEnd, 0);
    p.alive = true; weapons.advance(p, input(2, 1100, { fire: true, life: p.life - 1 })); assert.equal(p.ammo, 1);
});
