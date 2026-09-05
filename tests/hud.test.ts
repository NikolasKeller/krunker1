import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { UI } from '../src/client/ui';
import { Controls } from '../src/client/input';
import type { Renderer } from '../src/client/renderer';
import type { Network } from '../src/client/network';
import type { ClientMessage, GameEvent } from '../src/shared/types';
import { decodeServerMessage, encodeServerMessage } from '../src/shared/protocol';
import { Room } from '../src/server/simulation';
import { moveState, neutralInput } from '../src/shared/movement';
import { installDOM } from './dom';

const hudCSS = readFileSync(new URL('../src/client/style.css', import.meta.url), 'utf8');
function setup() {
    const env = installDOM(), room = new Room('HUD');
    const style = document.createElement('style');
    style.textContent = hudCSS;
    document.head.append(style);
    const a = room.add('Alpha', 'hunter', 'blue').state, b = room.add('<Bravo>', 'hunter', 'red').state;
    b.name = '<Bravo>';
    env.dom.window.HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, { get: () => () => {} })) as never;
    const sent: ClientMessage[] = [];
    room.round.phase = 'playing';
    const net = { id: a.id, room: room.id, status: 'CONNECTED', round: room.round, players: new Map([[a.id, a], [b.id, b]]), local: a, predicted: a, serverNow: 1000, remotePlayers: () => [], send: (m: ClientMessage) => sent.push(m) } as unknown as Network;
    const renderer = { fps: 60, viewmodel: { aim: 0 }, project: () => ({ x: 512, y: 280, visible: true }) } as unknown as Renderer;
    const ui = new UI(net); ui.menu = false; ui.visibility();
    const kill: GameEvent = { type: 'kill', killer: a.id, victim: b.id, killerName: a.name, victimName: b.name, team: a.team, headshot: true, weapon: 'sniper' };
    return { ...env, room, a, b, net, renderer, ui, sent, kill };
}
const node = (id: string) => document.getElementById(id)!;
const styleOf = (element: Element) => window.getComputedStyle(element);

test('health, empty magazine, reload lifecycle and authoritative team scores reach the HUD', () => {
    const { restore, a, net, renderer, ui } = setup();
    try {
        ui.update(100, renderer, false);
        assert.equal(node('health').textContent, '60'); assert.equal(node('health-max').textContent, '|60');
        assert.equal(node('health-bar').style.width, '100%');
        a.hp = 20; a.ammo = 0; net.round!.mode = 'tdm'; net.round!.red = 13; net.round!.blue = 17;
        ui.update(200, renderer, false);
        assert.equal(node('health-bar').classList.contains('low'), true);
        assert.equal(node('ammo-line').textContent, '0|3!!!');
        assert.equal(node('ammo-line').classList.contains('empty'), true);
        assert.equal(node('ammo-alert').classList.contains('hidden'), false);
        assert.equal(node('reload-prompt').textContent, '[R] Reload');
        assert.equal(node('team-scores').classList.contains('hidden'), false);
        assert.equal(node('team-scores').querySelector('.red b')!.textContent, '13');
        assert.equal(node('team-scores').querySelector('.blue b')!.textContent, '17');
        a.reloadEnd = 2000; ui.update(300, renderer, false);
        assert.equal(node('reload-prompt').textContent, 'RELOADING');
        a.reloadEnd = 0; a.ammo = 3; net.round!.mode = 'ffa'; ui.update(400, renderer, false);
        assert.equal(node('reload-prompt').textContent, '');
        assert.equal(node('ammo-line').classList.contains('empty'), false);
        assert.equal(node('ammo-alert').classList.contains('hidden'), true);
        assert.equal(node('team-scores').classList.contains('hidden'), true);
    } finally { restore(); }
});

test('decoded combat events show damage, headshot bonus, multi-kills and coloured chronological feed', () => {
    const { restore, a, b, renderer, ui, kill } = setup();
    try {
        const events: GameEvent[] = [{ type: 'hit', shooter: a.id, victim: b.id, damage: 175, zone: 'head', point: { x: 0, y: 1, z: 0 }, from: { x: 0, y: 1, z: 2 }, lethal: true }, kill];
        const decoded = decodeServerMessage(encodeServerMessage({ type: 'events', events }));
        assert.equal(decoded.type, 'events'); if (decoded.type !== 'events') return;
        for (const event of decoded.events) ui.event(event, renderer, 100);
        ui.update(100, renderer, false);
        const damage = node('damage-numbers').firstElementChild;
        assert.equal(damage?.textContent, '+175');
        assert.equal(styleOf(damage!).color, 'rgb(255, 229, 82)');
        assert.match(styleOf(damage!).animation, /damage-rise 1.1s ease-out forwards/);
        assert.equal(styleOf(node('hitmarker')).opacity, '1');
        assert.equal(styleOf(node('hitmarker')).color, 'rgb(255, 215, 108)');
        assert.equal(node('kill-notice').style.opacity, '1');
        assert.equal(node('kill-notice').textContent, 'HEADSHOT+50');
        assert.equal(styleOf(node('kill-notice').querySelector('span')!).color, 'rgb(255, 255, 255)');
        assert.equal(styleOf(node('kill-notice').querySelector('strong')!).color, 'rgb(255, 229, 82)');
        assert.equal(node('killfeed').textContent, 'You killed <Bravo>');
        assert.equal(node('killfeed').querySelector('svg, bravo'), null);
        assert.equal(node('killfeed').querySelector('.red')!.textContent, '<Bravo>');
        ui.update(150, renderer, false);
        assert.equal(node('damage-numbers').firstElementChild, damage, 'animation node survives frames');
        renderer.project = () => ({ x: -900, y: -100, visible: true });
        ui.event({ ...events[0], type: 'hit', shooter: a.id, victim: b.id, damage: 35, zone: 'body', point: { x: 0, y: 1, z: 0 }, from: { x: 0, y: 1, z: 2 }, lethal: false }, renderer, 160);
        const body = node('damage-numbers').querySelector<HTMLElement>('.body')!;
        assert.equal(body.textContent, '+35');
        assert.equal(styleOf(body).color, 'rgb(255, 229, 82)', 'ordinary hits are yellow too');
        ui.update(160, renderer, false);
        assert.equal(styleOf(node('hitmarker')).opacity, '1');
        assert.equal(styleOf(node('hitmarker')).color, 'rgb(255, 255, 255)');
        ui.update(321, renderer, false);
        assert.equal(styleOf(node('hitmarker')).opacity, '0', 'hitmarker expires without another hit');
        assert.equal(body.style.left, `${window.innerWidth / 2}px`, 'late hit feedback remains visible after turning away');
        ui.event(kill, renderer, 500); ui.update(500, renderer, false);
        assert.equal(node('kill-notice').textContent, 'DOUBLE KILL+50HEADSHOT');
        ui.event({ ...kill, killer: b.id, victim: a.id, killerName: b.name, victimName: a.name, team: 'red' }, renderer, 600);
        ui.update(600, renderer, false);
        assert.equal(node('killfeed').lastElementChild?.textContent, '<Bravo> killed Alpha');
        assert.equal(node('killfeed').lastElementChild?.querySelector('.blue')!.textContent, 'Alpha');
        ui.update(1300, renderer, false); assert.equal(node('damage-numbers').children.length, 0);
        ui.update(3200, renderer, false); assert.equal(node('kill-notice').style.opacity, '0');
        a.life++; ui.event(kill, renderer, 3300); ui.update(3300, renderer, false);
        assert.equal(node('kill-notice').textContent, 'HEADSHOT+50', 'respawn resets rapid-kill chain');
        ui.update(12000, renderer, false); assert.equal(node('killfeed').children.length, 0);
    } finally { restore(); }
});

test('an aimed authoritative TDM headshot reaches combat feedback and increments the correct team score', () => {
    const { restore, room, a, b, renderer, ui } = setup();
    try {
        room.start(1000);
        room.round.mode = 'tdm';
        Object.assign(a, moveState(32, 0, 15), { yaw: 0, pitch: 0, protectionEnd: 0 });
        Object.assign(b, moveState(32, 0, 0), { protectionEnd: 0 });
        const shooter = room.players.get(a.id)!;
        shooter.aimTime = 1;
        shooter.nextShot = 0;
        room.history.record(2000, [a, b]);
        room.events = [];
        room.fire(shooter, { ...neutralInput(1), shotTime: 2000 }, 2000);
        const message = decodeServerMessage(encodeServerMessage({ type: 'events', events: room.events }));
        assert.equal(message.type, 'events');
        if (message.type !== 'events') return;
        assert.ok(message.events.some(e => e.type === 'hit' && e.shooter === a.id && e.zone === 'head'));
        assert.ok(message.events.some(e => e.type === 'kill' && e.killer === a.id));
        for (const event of message.events) ui.event(event, renderer, 100);
        ui.update(100, renderer, false);
        assert.equal(node('damage-numbers').textContent, '+60', 'server reports the actual HP removed');
        assert.equal(styleOf(node('hitmarker')).opacity, '1');
        assert.equal(node('kill-notice').textContent, 'HEADSHOT+50');
        assert.equal(styleOf(node('team-scores')).display, 'flex');
        assert.equal(node('team-scores').querySelector('.blue b')!.textContent, '1');
        assert.equal(node('team-scores').querySelector('.red b')!.textContent, '0');
        assert.equal(styleOf(node('team-scores').querySelector('.blue i')!).backgroundColor, 'rgb(245, 243, 233)');
        assert.equal(styleOf(node('team-scores').querySelector('.red')!).color, 'rgb(241, 90, 96)');
        assert.equal(styleOf(node('score-top')).display, 'none', 'FFA score does not overlap team-mode feedback');
    } finally { restore(); }
});

test('other players hitting and killing do not show personal combat feedback', () => {
    const { restore, a, b, renderer, ui, kill } = setup();
    try {
        ui.event({ type: 'hit', shooter: b.id, victim: a.id, damage: 50, zone: 'body', point: { x: 0, y: 1, z: 0 }, from: { x: 0, y: 1, z: 2 }, lethal: true }, renderer, 100);
        ui.event({ ...kill, killer: b.id, victim: a.id }, renderer, 100);
        ui.update(100, renderer, false);
        assert.equal(node('damage-numbers').childElementCount, 0);
        assert.equal(styleOf(node('hitmarker')).opacity, '0');
        assert.equal(styleOf(node('kill-notice')).opacity, '0');
    } finally { restore(); }
});

test('the minimap defaults off, skips canvas work, and can be enabled persistently in settings', () => {
    const { restore, dom, renderer, ui, net } = setup();
    let draws = 0;
    try {
        dom.window.HTMLCanvasElement.prototype.getContext = (() => {
            draws++;
            return new Proxy({}, { get: () => () => {} });
        }) as never;
        ui.update(100, renderer, false);
        assert.equal(styleOf(node('minimap')).display, 'none');
        assert.equal(draws, 0, 'the default HUD does not draw an invisible minimap');
        const setting = node('minimap-setting') as HTMLSelectElement;
        assert.equal(setting.value, 'off');
        setting.value = 'on';
        setting.dispatchEvent(new dom.window.Event('change'));
        ui.update(200, renderer, false);
        assert.notEqual(styleOf(node('minimap')).display, 'none');
        assert.equal(draws, 1);
        const reloaded = new UI(net);
        assert.equal((node('minimap-setting') as HTMLSelectElement).value, 'on');
        reloaded.update(300, renderer, false);
        assert.equal(draws, 2);
        const savedSetting = node('minimap-setting') as HTMLSelectElement;
        savedSetting.value = 'off';
        savedSetting.dispatchEvent(new dom.window.Event('change'));
        reloaded.update(400, renderer, false);
        assert.equal(styleOf(node('minimap')).display, 'none');
        assert.equal(draws, 2);
        assert.equal(localStorage.getItem('arena-minimap'), 'off');
    } finally { restore(); }
});

test('changing rooms clears chat history and opening the lobby releases chat focus', async () => {
    const { restore, ui, net } = setup(), originalFetch = globalThis.fetch;
    try {
        globalThis.fetch = async () => ({ json: async () => ({ lan: [] }) }) as Response;
        await ui.welcomed();
        ui.chat({ type: 'chat', player: 'b', name: 'Bravo', team: 'red', text: 'old room' });
        await ui.welcomed();
        assert.equal(node('chat-log').children.length, 1, 'reconnect preserves this room history');
        ui.focusChat(); assert.equal(document.activeElement, node('chat-input'));
        ui.menu = true; ui.visibility();
        assert.notEqual(document.activeElement, node('chat-input'));
        net.room = 'NEXT'; await ui.welcomed();
        assert.equal(node('chat-log').children.length, 0);
    } finally { globalThis.fetch = originalFetch; restore(); }
});

test('chat opens deliberately, suppresses movement and shooting while typing, sends and cancels safely', () => {
    const { dom, restore, ui, sent } = setup();
    try {
        const controls = new Controls(document.createElement('canvas'));
        controls.locked = true; controls.onChat = () => ui.focusChat();
        // Dispatch on the body as browser keyboard events do.
        document.body.dispatchEvent(new dom.window.KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }));
        controls.fire = true;
        document.body.dispatchEvent(new dom.window.KeyboardEvent('keydown', { code: 'Enter', bubbles: true }));
        const input = node('chat-input') as HTMLInputElement;
        assert.equal(document.activeElement, input);
        input.value = 'wasd r 123';
        for (const code of ['KeyW', 'KeyR', 'Digit2', 'Space']) input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { code, bubbles: true }));
        const sample = controls.sample(1, 1000);
        assert.equal(sample.forward, 0); assert.equal(sample.fire, false); assert.equal(sample.reload, false); assert.equal(sample.slot, 1);
        node('chat-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
        assert.deepEqual(sent.at(-1), { type: 'chat', text: 'wasd r 123' });
        assert.notEqual(document.activeElement, input);
        document.body.dispatchEvent(new dom.window.KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }));
        assert.equal(controls.sample(2, 1100).forward, 1, 'movement resumes after chat');
        ui.focusChat(); input.value = 'cancel';
        input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { code: 'Escape', bubbles: true }));
        assert.equal(input.value, ''); assert.equal(sent.length, 1);
        ui.chat({ type: 'chat', player: 'b', name: '<img>', team: 'red', text: '<script>hello</script>' });
        assert.equal(node('chat-log').textContent, '<img>: <script>hello</script>');
        assert.equal(node('chat-log').querySelector('img,script'), null);
        for (let i = 0; i < 10; i++) ui.chat({ type: 'chat', player: 'b', name: 'Bravo', team: 'red', text: String(i) });
        assert.equal(node('chat-log').children.length, 4);
    } finally { restore(); }
});
