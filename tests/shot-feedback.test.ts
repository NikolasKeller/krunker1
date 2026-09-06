import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ShotFeedback } from '../src/client/shot-feedback';
import { Effects } from '../src/client/effects';
import { Viewmodel } from '../src/client/viewmodel';
import { Room } from '../src/server/simulation';
import { moveState, neutralInput } from '../src/shared/movement';
import { WEAPONS } from '../src/shared/weapons';
import type { WeaponId } from '../src/shared/types';

for (const weapon of Object.keys(WEAPONS) as WeaponId[]) test(`${weapon}: fire input creates visuals in the same frame, before any server message`, () => {
    const room = new Room('VISUAL'); room.botCount = 0;
    const actor = room.add('Shooter', 'triggerman', 'blue'); room.start(0);
    const p = actor.state;
    Object.assign(p, moveState(34, 0, 20), { weapon, ammo: WEAPONS[weapon].magazine, yaw: 0, pitch: 0, protectionEnd: 0 });
    const scene = new THREE.Scene(), effects = new Effects(scene), viewmodel = new Viewmodel();
    viewmodel.setWeapon(weapon); viewmodel.update(1, 0, 0, false, 0, 0, 0);
    let sounds = 0;
    const feedback = new ShotFeedback(effects, viewmodel, { shot: () => { sounds++; } });
    const input = { ...neutralInput(1), life: p.life, fire: true };
    const camera = new THREE.PerspectiveCamera(90, 1, .06, 220); camera.position.set(p.x, p.y + 1.62, p.z);
    const muzzle = viewmodel.muzzlePosition(camera);
    const predicted = { ...p };
    const recoil = feedback.fire(predicted, input, 0, 0, muzzle);
    const tracers = () => scene.children.filter(c => c instanceof THREE.Line) as THREE.Line[];
    assert.equal(room.events.filter(e => e.type === 'shot').length, 0, 'no authoritative shot yet');
    assert.equal(tracers().length, weapon === 'knife' ? 0 : WEAPONS[weapon].pellets);
    assert.equal(sounds, 1); assert.equal(viewmodel.kick, 1); assert.ok(recoil);
    if (weapon !== 'knife') assert.ok(viewmodel.flashTime > 0);
    assert.equal(predicted.hp, p.hp, 'no predicted damage');
    const before = tracers().map(line => Array.from(line.geometry.getAttribute('position').array));
    room.fire(actor, input, 500);
    const event = room.events.find(e => e.type === 'shot')!;
    assert.equal(event.type, 'shot');
    if (weapon !== 'knife') event.ends.forEach((end, i) => {
        const points = before[i];
        assert.ok(Math.hypot(points[3] - end.x, points[4] - end.y, points[5] - end.z) < 1e-4, 'client uses server spread, recoil, range and world hit');
        assert.ok(Math.hypot(points[0] - muzzle.x, points[1] - muzzle.y, points[2] - muzzle.z) < 1e-4, 'starts at muzzle');
    });
    feedback.confirm(event);
    assert.equal(sounds, 1); assert.equal(tracers().length, before.length, 'confirmation does not duplicate tracer/sound');
    // A disagreement changes only the existing impact, without another flash.
    const decals = effects.items.filter(e => e.max === 5);
    if (decals.length) {
        const object = decals[0].object;
        feedback.fire({ ...predicted, ammo: 10 }, { ...input, seq: 2 }, 0, 0, muzzle);
        const latest = effects.items.filter(e => e.max === 5).at(-WEAPONS[weapon].pellets)!.object;
        feedback.confirm({ ...event, seq: 2, ends: event.ends.map(() => ({ x: 34, y: 1.6, z: 15 })) });
        assert.ok(latest.position.distanceTo(new THREE.Vector3(34, 1.6, 15)) < .03);
        assert.notEqual(latest, object);
    }
});

test('all viewmodels retain only the right arm through hip, aim and reload poses', () => {
    const vm = new Viewmodel();
    const right = vm.rightArm;
    for (const weapon of Object.keys(WEAPONS) as WeaponId[]) for (const aim of [false, true]) for (const reload of [0, .2, .5, .8]) {
        vm.setWeapon(weapon);
        vm.update(.5, 1, 10, aim, reload ? 1000 + WEAPONS[weapon].reload * (1 - reload) : 0, 1000, 0);
        assert.equal('leftArm' in vm, false);
        assert.equal(vm.rightArm, right); assert.equal(right.parent, vm.rig);
        assert.equal(vm.rig.children.filter(c => c instanceof THREE.Group && c !== vm.gun).length, 1);
    }
});
