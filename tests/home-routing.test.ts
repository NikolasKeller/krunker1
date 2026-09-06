import assert from 'node:assert/strict';
import test from 'node:test';
import { installDOM } from './dom';
import { Network } from '../src/client/network';
import { UI } from '../src/client/ui';
import { Room } from './sandyard-room';

function setup(url = 'https://furo.example/') {
    const env = installDOM(url), net = new Network(), ui = new UI(net);
    const joins: UI['joinConfig'][] = [];
    ui.onRoom = () => { joins.push(ui.joinConfig); };
    const enter = (code = 'FRND5') => {
        const room = new Room(code), p = room.add(ui.joinConfig.name, ui.selected, ui.team).state;
        net.room = code; net.id = net.host = p.id; net.status = 'CONNECTED';
        net.ws = { close() {} } as WebSocket;
        net.players.set(p.id, p); net.predicted = { ...p }; net.round = room.round;
        ui.navigation.go('lobby', code, true); ui.visibility(); ui.updateLobby();
    };
    const shown = (id: string) => !document.getElementById(id)!.classList.contains('hidden');
    const pop = (direction: 'back' | 'forward') => new Promise<void>(resolve => {
        env.dom.window.addEventListener('popstate', () => resolve(), { once: true });
        history[direction]();
    });
    return { ...env, net, ui, joins, enter, shown, pop, close() { net.disconnect(); env.restore(); } };
}

test('bare URL opens home, ignores a saved room, and remembers the player and class', () => {
    const env = installDOM('https://furo.example/');
    localStorage.setItem('arena-room', 'OLD55'); localStorage.setItem('arena-name', 'Niko'); localStorage.setItem('arena-class', 'vince');
    const net = new Network();
    try {
        const ui = new UI(net);
        assert.equal(ui.home, true); assert.equal(ui.joinConfig.room, ''); assert.equal(net.ws, undefined);
        assert.equal(document.querySelector('.room-panel')!.classList.contains('hidden'), true);
        assert.equal((document.getElementById('home-name') as HTMLInputElement).value, 'Niko');
        assert.equal(document.getElementById('home-class-name')!.textContent, 'VINCE');
    } finally { net.disconnect(); env.restore(); }
});

test('home class and callsign changes immediately reach the character callback and create request', () => {
    const env = setup();
    try {
        const { ui, dom } = env;
        let displayed = ''; ui.onClass = id => { displayed = id; };
        const name = document.getElementById('home-name') as HTMLInputElement;
        name.value = 'New callsign'; name.dispatchEvent(new dom.window.Event('input'));
        document.querySelector<HTMLButtonElement>('#home [data-home-class="runngun"]')!.click();
        assert.equal(displayed, 'runngun'); assert.equal(localStorage.getItem('arena-class'), 'runngun');
        assert.match(document.getElementById('home-character')!.getAttribute('aria-label')!, /RUN N GUN.*COMPACT SMG/);
        assert.equal(document.querySelector('#home [aria-pressed="true"]')!.getAttribute('data-home-class'), 'runngun');
        document.getElementById('home-create')!.click();
        assert.deepEqual(env.joins, [{ name: 'New callsign', room: '', classId: 'runngun', team: 'blue', create: true }]);
        assert.equal(ui.home, false); assert.equal(ui.navigation.route.screen, 'lobby');
    } finally { env.close(); }
});

test('Join Lobby asks for a code; empty input cannot create a lobby and Enter joins the normalized room', () => {
    const env = setup();
    try {
        document.getElementById('home-join')!.click();
        assert.ok(env.shown('home-join-form')); assert.equal(env.ui.home, true); assert.equal(env.joins.length, 0);
        assert.equal(document.activeElement?.id, 'home-room-code');
        const form = document.getElementById('home-join-form') as HTMLFormElement;
        form.dispatchEvent(new env.dom.window.Event('submit', { cancelable: true }));
        assert.equal(env.joins.length, 0); assert.match(document.getElementById('home-join-error')!.textContent!, /Enter a room code/);
        (document.getElementById('home-room-code') as HTMLInputElement).value = ' frnd5 ';
        form.dispatchEvent(new env.dom.window.Event('submit', { cancelable: true }));
        assert.equal(env.joins[0].room, 'FRND5'); assert.equal(env.joins[0].create, false);
        assert.equal(env.ui.home, false); assert.equal(new URL(location.href).searchParams.get('room'), 'FRND5');
    } finally { env.close(); }
});

test('direct room invite bypasses home immediately and Back provides a home destination', async () => {
    const env = setup('https://furo.example/?room=frnd5&source=invite');
    try {
        assert.equal(env.ui.home, false); assert.equal(env.shown('home'), false);
        assert.equal(env.ui.joinConfig.room, 'FRND5'); assert.equal(env.ui.joinConfig.create, false);
        env.enter(); await env.pop('back');
        assert.equal(env.ui.home, true); assert.equal(env.net.ws, undefined);
        assert.equal(new URL(location.href).searchParams.has('room'), false);
        assert.equal(new URL(location.href).searchParams.get('source'), 'invite');
        await env.pop('forward');
        assert.equal(env.ui.home, false); assert.equal(env.joins.at(-1)?.room, 'FRND5');
    } finally { env.close(); }
});

for (const screen of ['lobby', 'match'] as const) test(`leaving ${screen} returns home, clears old room state and allows creating again`, () => {
    const env = setup('https://furo.example/?room=FRND5');
    try {
        env.enter();
        if (screen === 'match') { env.net.round!.phase = 'playing'; env.ui.showMatch(); }
        document.getElementById(screen === 'match' ? 'leave-match' : 'leave-lobby')!.click();
        assert.equal(env.ui.home, true); assert.ok(env.shown('home')); assert.equal(env.shown('hud'), false);
        assert.equal(location.search, ''); assert.equal(env.net.ws, undefined); assert.equal(env.net.round, undefined);
        assert.equal(env.net.predicted, undefined); assert.equal(env.net.players.size, 0); assert.equal(env.net.room, '');
        env.ui.syncPhase(''); assert.equal(env.ui.home, true, 'a later game frame cannot reopen the room');
        document.getElementById('home-create')!.click(); assert.equal(env.joins.at(-1)?.create, true);
    } finally { env.close(); }
});

test('Back/Forward between home, lobby and match keeps the live lobby usable and resumes only a live match', async () => {
    const env = setup();
    try {
        document.getElementById('home-create')!.click(); env.enter();
        env.net.round!.phase = 'playing'; env.ui.syncPhase('playing');
        assert.equal(env.ui.navigation.route.screen, 'match'); assert.equal(env.ui.menu, false);
        await env.pop('back');
        assert.equal(env.ui.navigation.route.screen, 'lobby'); assert.equal(env.ui.menu, true);
        assert.ok(env.net.ws); assert.equal(document.getElementById('deploy-label')!.textContent, 'JOIN MATCH');
        await env.pop('forward');
        assert.equal(env.ui.navigation.route.screen, 'match'); assert.equal(env.ui.menu, false); assert.equal(env.ui.paused, true);
        await env.pop('back'); env.net.round!.phase = 'results'; await env.pop('forward');
        assert.equal(env.ui.navigation.route.screen, 'lobby'); assert.equal(env.ui.menu, true, 'a finished match cannot reopen gameplay');
        await env.pop('back'); await env.pop('back');
        assert.equal(env.ui.home, true); assert.equal(env.net.ws, undefined);
    } finally { env.close(); }
});

test('round results retain the existing lobby and match settings for the next round', () => {
    const env = setup('https://furo.example/?room=FRND5');
    try {
        env.enter(); env.net.round!.mode = 'tdm'; env.net.round!.scoreLimit = 50;
        env.ui.syncPhase('playing'); env.net.round!.phase = 'results'; env.ui.syncPhase('results');
        assert.equal(env.ui.home, false); assert.equal(env.ui.menu, true);
        assert.equal(env.net.round!.scoreLimit, 50); assert.equal(env.net.round!.mode, 'tdm');
    } finally { env.close(); }
});
