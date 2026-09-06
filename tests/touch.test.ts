import assert from 'node:assert/strict';
import test from 'node:test';
import { TouchInput, joystickVector, touchDevice, touchMarkup } from '../src/client/touch';
import { Controls } from '../src/client/input';
import { assistedLook } from '../src/client/aim-assist';
import { FrameBudget } from '../src/client/frame-budget';
import { move, moveState, neutralInput } from '../src/shared/movement';
import { wireInput } from '../src/shared/protocol';
import { Room } from '../src/server/simulation';
import { installDOM } from './dom';

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);
test('joystick has a radial dead zone, smooth analogue magnitude and circular clamping', () => {
    assert.deepEqual(joystickVector(0, 0), { forward: 0, strafe: 0 });
    near(joystickVector(7, 0).strafe, 0);
    const half = joystickVector(56 * (.14 + .86 / 2), 0); near(half.strafe, .5);
    const diagonal = joystickVector(1000, -1000); near(Math.hypot(diagonal.forward, diagonal.strafe), 1);
    near(diagonal.forward, Math.SQRT1_2); near(diagonal.strafe, Math.SQRT1_2);
    near(joystickVector(0, 56).forward, -1);
});
test('analogue magnitude reaches shared physics; desktop full-speed and diagonals retain their speed', () => {
    const velocities = [0, .25, 1].map(forward => {
        const p = moveState(34, 0, 35);
        for (let i = 0; i < 20; i++) move(p, wireInput({ ...neutralInput(i), forward }));
        return Math.hypot(p.vx, p.vz);
    });
    near(velocities[0], 0); near(velocities[1] / velocities[2], .25);
    const p = moveState(34, 0, 35);
    for (let i = 0; i < 20; i++) move(p, { ...neutralInput(i), forward: 1, strafe: 1 });
    near(Math.hypot(p.vx, p.vz) / velocities[2], 1.12);
});
test('moving, looking, firing and jumping track independent pointers across control boundaries', () => {
    const t = new TouchInput();
    assert.equal(t.begin(1, 'move', 120, 230), true); assert.equal(t.begin(2, 'move', 80, 80), false);
    t.begin(2, 'look', 500, 120); t.begin(3, 'fire', 620, 200); t.begin(4, 'jump', 720, 100);
    t.move(1, 120, 174); t.move(2, 515, 124); t.move(2, 520, 118); t.move(3, 630, 205);
    near(t.movement.forward, 1); assert.equal(t.held('fire'), true); assert.equal(t.held('jump'), true);
    assert.deepEqual(t.consumeLook(), { x: 30, y: 3 }); assert.deepEqual(t.consumeLook(), { x: 0, y: 0 });
    t.end(2); assert.equal(t.held('fire'), true); near(t.movement.forward, 1);
    t.end(3, true); assert.equal(t.held('fire'), false);
    t.end(4); assert.equal(t.held('jump'), true, 'a quick tap survives until a fixed input step');
    t.consumed({ jump: false, slide: false, reload: false }); assert.equal(t.held('jump'), true, 'a frozen pending shot must not swallow a later action');
    t.consumed(); assert.equal(t.held('jump'), false);
    t.clear(); assert.equal(t.pointers.size, 0); assert.deepEqual(t.movement, { forward: 0, strafe: 0 });
});
function touchDOM() {
    const env = installDOM();
    Object.defineProperty(window.navigator, 'maxTouchPoints', { configurable: true, value: 5 });
    document.getElementById('ui')!.innerHTML = touchMarkup;
    const canvas = document.createElement('canvas'); document.body.prepend(canvas);
    let requests = 0; canvas.requestPointerLock = () => { requests++; return Promise.resolve(); };
    const controls = new Controls(canvas);
    function pointer(kind: string, id: number, target: Element, x = 0, y = 0, type = 'touch') {
        const event = new window.Event(kind, { bubbles: true, cancelable: true });
        Object.assign(event, { pointerId: id, pointerType: type, clientX: x, clientY: y });
        target.dispatchEvent(event);
        return event;
    }
    return { ...env, controls, canvas, pointer, requests: () => requests };
}
test('touch starts without pointer lock, keyboard still works, and mouse switches a hybrid back to pointer lock', () => {
    const env = touchDOM();
    try {
        assert.equal(touchDevice(), true);
        const { controls, canvas, pointer } = env;
        controls.lock(); assert.equal(controls.locked, true); assert.equal(env.requests(), 0);
        document.body.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }));
        assert.equal(controls.sample(1, 0).forward, 1);
        pointer('pointerdown', 1, canvas, 0, 0, 'mouse');
        assert.equal(controls.touchMode, false); assert.equal(controls.locked, false);
        controls.lock(); assert.equal(env.requests(), 1);
        pointer('pointerdown', 2, canvas);
        assert.equal(controls.touchMode, true); controls.lock(); assert.equal(env.requests(), 1);
    } finally { env.restore(); }
});
test('DOM pointer path supports two-thumb movement + fire + look, pitch clamping, aim toggle and cancellation', () => {
    const env = touchDOM();
    try {
        const { controls: c, pointer } = env; c.lock();
        const move = document.querySelector('[data-touch=move]')!, fire = document.querySelector('[data-touch=fire]')!;
        const root = document.getElementById('touch-controls')!;
        pointer('pointerdown', 10, move, 100, 220); pointer('pointermove', 10, root, 100, 164);
        pointer('pointerdown', 11, fire, 620, 220); pointer('pointermove', 11, root, 645, 200);
        c.updateLook(1 / 60);
        assert.equal(c.sample(1, 0).forward, 1); assert.equal(c.sample(1, 0).fire, true);
        near(c.yaw, -.1); near(c.pitch, .08);
        pointer('pointermove', 11, root, 645, -10000); c.updateLook(1 / 60); near(c.pitch, 1.54);
        pointer('pointerdown', 12, document.querySelector('[data-touch-command=aim]')!); assert.equal(c.aim, true);
        pointer('pointercancel', 11, root); assert.equal(c.fire, false); assert.equal(c.sample(2, 0).forward, 1);
        pointer('pointerdown', 13, document.querySelector('[data-touch-slot="2"]')!); assert.equal(c.slot, 2);
        window.dispatchEvent(new window.Event('blur')); assert.equal(c.locked, false); assert.equal(c.sample(3, 0).forward, 0); assert.equal(c.aim, false);
    } finally { env.restore(); }
});
test('portrait start cannot activate movement and orientation change releases every held contact', () => {
    const env = touchDOM();
    try {
        env.controls.lock(); env.controls.touch.begin(1, 'fire', 300, 200);
        Object.defineProperty(window, 'innerHeight', { value: 900 }); Object.defineProperty(window, 'innerWidth', { value: 400 });
        window.dispatchEvent(new window.Event('resize'));
        assert.equal(env.controls.locked, false); assert.equal(env.controls.fire, false);
        env.controls.lock(); assert.equal(env.controls.locked, false); assert.equal(env.requests(), 0);
    } finally { env.restore(); }
});
test('aim assist has bounded drag-only magnetism; ignores friends, cover and dead targets', () => {
    const room = new Room('ASSIST'), p = room.add('You', 'hunter', 'blue').state;
    Object.assign(p, moveState(34, 0, 20));
    const q = { ...p, id: 'enemy', team: 'red' as const, x: 34.3, z: 10, protectionEnd: 0 };
    const pitch = Math.atan2(1.1 - 1.62, 10), raw = .004;
    const no = assistedLook(0, pitch, raw, 0, 1 / 60, p, [], 'tdm', 1000);
    const yes = assistedLook(0, pitch, raw, 0, 1 / 60, p, [q], 'tdm', 1000);
    assert.ok(yes.yaw < no.yaw); assert.ok(Math.abs(yes.yaw - no.yaw) < .002);
    assert.deepEqual(assistedLook(0, pitch, 0, 0, 1, p, [q], 'tdm', 1000), { yaw: 0, pitch });
    for (const target of [{ ...q, team: 'blue' as const }, { ...q, alive: false }]) assert.deepEqual(assistedLook(0, pitch, raw, 0, 1 / 60, p, [target], 'tdm', 1000), no);
    const wallPlayer = { ...p, x: -28, y: 0, z: 0 }, wallTarget = { ...q, x: 28, y: 0, z: 0 };
    assert.deepEqual(assistedLook(-Math.PI / 2, 0, raw, 0, 1 / 60, wallPlayer, [wallTarget], 'ffa', 1000), { yaw: -Math.PI / 2 + raw, pitch: 0 });
});
test('mobile performance governor reduces resolution before a stable 30 Hz fallback; desktop is unaffected', () => {
    const mobile = new FrameBudget(true), desktop = new FrameBudget(false);
    let time = 0;
    for (let i = 0; i < 500; i++) { time += 25; mobile.observe(time, true); desktop.observe(time, true); }
    near(mobile.scale, .7); assert.equal(mobile.targetHz, 30); assert.equal(desktop.scale, 1); assert.equal(desktop.targetHz, 60);
    let rendered = 0;
    for (let i = 0; i < 120; i++) { time += 1000 / 60; if (mobile.shouldRender(time)) rendered++; }
    assert.ok(rendered >= 59 && rendered <= 61, `rendered ${rendered}`);
    assert.equal(mobile.targetHz, 30); mobile.reset(); assert.equal(mobile.targetHz, 60);
    let cappedFrames = 0;
    for (let i = 1; i <= 120; i++) if (mobile.shouldRender(i * 1000 / 120)) cappedFrames++;
    assert.equal(cappedFrames, 60, '120 Hz phones do not render redundant frames above the target');
});
