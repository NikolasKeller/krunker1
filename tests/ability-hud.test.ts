import test from 'node:test';
import assert from 'node:assert/strict';
import { installDOM } from './dom';
import { Room } from './sandyard-room';
import { abilityMarkup, updateAbilityHUD } from '../src/client/ability-hud';
import { touchMarkup } from '../src/client/touch';
import { Controls } from '../src/client/input';
import { CLASS_IDS } from '../src/shared/weapons';
import { ABILITIES } from '../src/shared/abilities';
import { TacticalInput } from '../src/client/tactical-input';
import { TacticalEffects } from '../src/client/tactical-effects';
import * as THREE from 'three';

test('all class HUDs and touch buttons show ready, active, cooldown, death and round-end states', () => {
    const { restore } = installDOM();
    try {
        document.getElementById('ui')!.innerHTML = abilityMarkup + touchMarkup;
        for (const id of CLASS_IDS) {
            const p = new Room('HUD').add('HUD', id, 'blue').state;
            const card = document.getElementById('hud-ability')!, touch = document.getElementById('touch-ability')!;
            updateAbilityHUD(p, 10000, true);
            assert.equal(card.dataset.state, 'ready'); assert.match(card.textContent!, /READY/); assert.match(touch.textContent!, new RegExp(ABILITIES[id].name));
            p.abilityUntil = 13000; p.abilityReadyAt = 75000; p.grenadeReadyAt = 70000; p.grenadeUntil = 12200;
            updateAbilityHUD(p, 11000, true); assert.equal(card.dataset.state, 'active'); assert.match(card.textContent!, /ACTIVE · 2.0s/); assert.equal(touch.getAttribute('aria-disabled'), 'true');
            updateAbilityHUD(p, 20000, true); assert.equal(card.dataset.state, 'cooldown'); assert.match(card.textContent!, /55s/);
            p.alive = false; updateAbilityHUD(p, 20000, true); assert.match(card.textContent!, /RESPAWNING · 55s/);
            updateAbilityHUD(p, 20000, false); assert.match(card.textContent!, /ROUND ENDED/);
        }
    } finally { restore(); }
});

test('Q/G and fast touch taps request once, ignore repeat, and never queue a cooldown press for later', () => {
    const { dom, restore } = installDOM();
    try {
        document.getElementById('ui')!.innerHTML = abilityMarkup + touchMarkup;
        const canvas = document.createElement('canvas'); document.body.append(canvas);
        const c = new Controls(canvas); c.locked = true;
        document.body.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, code: 'KeyQ' }));
        document.body.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, code: 'KeyG' }));
        let i = c.sample(1, 10000); assert.ok(i.ability && i.grenade); c.consumed(i);
        document.body.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, code: 'KeyQ', repeat: true }));
        assert.equal(c.sample(2, 10001).ability, undefined);
        const p = new Room('BUTTONS').add('Player', 'runngun', 'blue').state; p.abilityReadyAt = 20000;
        c.touch.begin(8, 'ability', 100, 100); c.touch.end(8);
        i = c.sample(3, 11000); assert.equal(i.ability, true);
        assert.equal(new TacticalInput().prepare(i, p, true, 11000).ability, undefined); c.consumed(i);
        assert.equal(c.sample(4, 20000).ability, undefined);
        c.touch.begin(9, 'grenade', 100, 100); c.touch.end(9, true); assert.equal(c.sample(5, 20000).grenade, undefined);
        c.touch.begin(10, 'ability', 100, 100); c.clear(); assert.equal(c.sample(6, 20000).ability, undefined);
    } finally { restore(); }
});

test('grenade rendering uses the authoritative arc, warns locally, and cleans up on cancel/end', () => {
    const { restore } = installDOM();
    try {
        document.getElementById('ui')!.innerHTML = abilityMarkup;
        const scene = new THREE.Scene(), effects = new TacticalEffects(scene), p = new Room('FX').add('P', 'vince', 'blue').state;
        Object.assign(p, { x: 34, y: 0, z: 20 });
        const e = { type: 'grenade' as const, id: 'g', owner: p.id, phase: 'flight' as const, position: { x: 34, y: 1.6, z: 20 }, velocity: { x: 0, y: 5, z: -18 }, time: 10000, until: 12200 };
        assert.ok(effects.event(e, 10000)); effects.update(10100, [], p);
        assert.ok(scene.children[0].position.y > 1.6); assert.ok(scene.children[0].position.z < 20);
        assert.match(document.getElementById('grenade-warning')!.textContent!, /MOVE/);
        effects.event({ ...e, phase: 'cancel' }, 10101); assert.equal(scene.children.length, 0);
        effects.event(e, 10000); effects.clear(); assert.equal(scene.children.length, 0);
    } finally { restore(); }
});
