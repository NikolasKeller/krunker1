import assert from 'node:assert/strict';
import test from 'node:test';
import { UI } from '../src/client/ui';
import { LOBBY_UPDATE_MS } from '../src/client/lobby';
import type { Network } from '../src/client/network';
import { Room } from '../src/server/simulation';
import { installDOM } from './dom';
import { Controls } from '../src/client/input';
import type { ClientMessage } from '../src/shared/types';

function setup() {
    const env = installDOM(), room = new Room('ABCDE');
    const a = room.add('Alpha', 'hunter', 'blue').state, b = room.add('Bravo', 'hunter', 'red').state;
    const net = { id: a.id, room: room.id, host: a.id, ws: {}, status: 'CONNECTED', round: room.round, players: new Map([[a.id, a], [b.id, b]]), local: a, serverNow: 1000, difficulty: 'normal', bots: 0, send() {} } as unknown as Network;
    const ui = new UI(net);
    ui.updateLobby();
    return { ...env, net, ui, a, b };
}

test('idle lobby polls produce no DOM mutations and preserve every control and text target', () => {
    const { dom, restore, net, ui } = setup();
    try {
        const panel = document.querySelector('.room-panel')!;
        const controls = [...panel.querySelectorAll('button, input, select')];
        const label = document.getElementById('deploy-label')!, text = label.firstChild;
        const observer = new dom.window.MutationObserver(() => {});
        observer.observe(panel, { subtree: true, childList: true, attributes: true, characterData: true });
        const before = ui.lobby.metrics;
        // Ten seconds of lobby polling while unrelated snapshots keep arriving.
        for (let i = 0; i < 100; i++) { net.local!.x++; ui.updateLobby(); }
        assert.equal(ui.lobby.metrics.polls - before.polls, 100);
        assert.equal(ui.lobby.metrics.updates, before.updates);
        assert.equal(ui.lobby.metrics.writes, before.writes);
        assert.equal(observer.takeRecords().length, 0);
        assert.deepEqual([...panel.querySelectorAll('button, input, select')], controls);
        assert.equal(label.firstChild, text);
        assert.equal(LOBBY_UPDATE_MS, 100);
        observer.disconnect();
    } finally { restore(); }
});

test('callsign focus, draft and caret survive ready, roster, team and countdown updates', () => {
    const { dom, restore, ui, net, a, b } = setup();
    try {
        const input = document.getElementById('player-name') as HTMLInputElement;
        input.focus(); input.value = 'Typing a callsign'; input.setSelectionRange(3, 8, 'backward');
        const button = document.getElementById('deploy') as HTMLButtonElement;
        const label = document.getElementById('deploy-label')!;
        const row = document.querySelector(`[data-player-id="${b.id}"]`)!;
        a.ready = true; b.team = 'blue'; ui.updateLobby();
        b.name = '<Different>'; b.ready = true; net.round!.phase = 'countdown'; net.round!.nextAt = 4000;
        ui.updateLobby();
        assert.equal(document.activeElement, input);
        assert.equal(document.getElementById('player-name'), input);
        assert.equal(input.value, 'Typing a callsign');
        assert.equal(input.selectionStart, 3); assert.equal(input.selectionEnd, 8); assert.equal(input.selectionDirection, 'backward');
        assert.equal(document.getElementById('deploy'), button);
        assert.equal(document.getElementById('deploy-label'), label);
        assert.equal(document.querySelector(`[data-player-id="${b.id}"]`), row);
        assert.ok(row.textContent!.includes('<Different>'));
        assert.equal(row.querySelector('different'), null, 'names remain text');
        assert.ok(button instanceof dom.window.HTMLButtonElement);
        assert.equal(button.tabIndex, 0); assert.equal(button.disabled, false);
        const sent: ClientMessage[] = []; net.send = message => { sent.push(message); };
        ui.onDeploy = () => { throw new Error('Gameplay setup must not block ready messages'); };
        label.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
        assert.deepEqual(sent.at(-1), { type: 'ready', ready: false }, 'retained target sends unready through the button handler');
    } finally { restore(); }
});

test('create and ready buttons work without gameplay initialization, and Space remains available to buttons', () => {
    const { dom, restore, ui, net } = setup();
    try {
        const sent: ClientMessage[] = []; net.send = message => { sent.push(message); };
        ui.onDeploy = () => { throw new Error('Audio/renderer unavailable'); };
        const button = document.getElementById('deploy') as HTMLButtonElement;
        button.click(); assert.deepEqual(sent.at(-1), { type: 'ready', ready: true });
        net.ws = undefined; net.players.clear();
        let creates = 0; ui.onRoom = () => creates++;
        ui.updateLobby(); button.click(); assert.equal(creates, 1);
        new Controls(document.createElement('canvas'));
        button.focus();
        const event = new dom.window.KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, cancelable: true });
        button.dispatchEvent(event);
        assert.equal(event.defaultPrevented, false, 'game controls must not cancel native button activation');
    } finally { restore(); }
});

test('results and unchanged countdown seconds retain nodes without mutations', () => {
    const { dom, restore, ui, net, a } = setup();
    try {
        net.round!.phase = 'results'; net.round!.winner = a.name; net.round!.nextAt = 5000;
        net.round!.results = [{ id: a.id, name: a.name, kills: 3, deaths: 1, score: 300, team: a.team, bot: false }];
        ui.updateLobby();
        const panel = document.querySelector('.room-panel')!, result = document.querySelector('#result-list > div');
        const observer = new dom.window.MutationObserver(() => {});
        observer.observe(panel, { subtree: true, childList: true, attributes: true, characterData: true });
        for (let i = 0; i < 10; i++) ui.updateLobby();
        assert.equal(observer.takeRecords().length, 0);
        assert.equal(document.querySelector('#result-list > div'), result);
        assert.equal((document.getElementById('deploy') as HTMLButtonElement).disabled, true);
        net.round!.phase = 'lobby'; ui.updateLobby();
        assert.equal(document.querySelector('#result-list > div'), result);
        observer.disconnect();
    } finally { restore(); }
});


test('a slow established connection keeps lobby actions available and reports the actual status', () => {
    const { restore, ui, net } = setup();
    try {
        net.status = 'CONNECTION SLOW'; ui.updateLobby();
        assert.match(document.getElementById('lobby-status')!.textContent!, /Connection slow/);
        assert.equal((document.getElementById('deploy') as HTMLButtonElement).disabled, false);
        const sent: ClientMessage[] = []; net.send = message => { sent.push(message); };
        (document.getElementById('deploy') as HTMLButtonElement).click();
        assert.deepEqual(sent.at(-1), { type: 'ready', ready: true });
        net.status = 'RECONNECTING'; ui.updateLobby();
        assert.match(document.getElementById('deploy-label')!.textContent!, /RECONNECTING/);
    } finally { restore(); }
});

test('bot selectors are visible outside collapsed settings and send zero and every difficulty', () => {
    const { dom, restore, ui, net } = setup();
    try {
        const bots = document.getElementById('bot-count') as HTMLSelectElement;
        const difficulty = document.getElementById('difficulty') as HTMLSelectElement;
        assert.equal(bots.closest('details'), null);
        assert.equal(difficulty.closest('details'), null);
        assert.equal(bots.disabled, false);
        assert.match(bots.options[0].textContent!, /No bots/);
        const sent: ClientMessage[] = []; net.send = message => { sent.push(message); };
        bots.value = '0'; bots.dispatchEvent(new dom.window.Event('change'));
        assert.deepEqual(sent.at(-1), { type: 'configure', bots: 0 });
        for (const level of ['easy', 'normal', 'hard']) {
            difficulty.value = level; difficulty.dispatchEvent(new dom.window.Event('change'));
            assert.deepEqual(sent.at(-1), { type: 'configure', difficulty: level });
        }
        net.host = 'friend'; net.bots = 2; net.difficulty = 'easy'; ui.updateLobby();
        assert.equal(bots.disabled, true); assert.equal(difficulty.disabled, true);
        assert.equal(bots.value, '2'); assert.equal(difficulty.value, 'easy');
        assert.equal(document.getElementById('bot-settings-status')!.textContent, 'SET BY THE HOST');
        net.host = net.id; net.round!.phase = 'playing'; ui.updateLobby();
        assert.equal(bots.disabled, true);
        net.round!.phase = 'lobby'; ui.updateLobby();
        assert.equal(bots.disabled, false); assert.equal(bots.value, '2');
    } finally { restore(); }
});

test('team cards retain identity across moves and FFA, with visible class, self, host, bot and ready states', () => {
    const { restore, ui, net, a, b } = setup();
    try {
        const bot = { ...b, id: 'bot', name: 'Kilo', bot: true, classId: 'runngun' as const };
        net.players.set(bot.id, bot); net.round!.mode = 'tdm'; a.ready = true;
        ui.updateLobby();
        const card = (id: string) => document.querySelector<HTMLElement>(`[data-player-id="${id}"]`)!;
        const self = card(a.id), friend = card(b.id), botCard = card(bot.id);
        assert.equal(document.querySelector('#blue-roster')!.children.length, 1);
        assert.equal(document.querySelector('#red-roster')!.children.length, 2);
        assert.equal(document.getElementById('red-count')!.textContent, '2');
        assert.equal(document.getElementById('ready-count')!.textContent, '1 / 2');
        assert.match(document.getElementById('waiting-players')!.textContent!, /Bravo/);
        assert.ok(self.classList.contains('is-self'));
        assert.ok(!self.querySelector('.you-badge')!.classList.contains('hidden'));
        assert.ok(!self.querySelector('.host-badge')!.classList.contains('hidden'));
        assert.ok(!botCard.querySelector('.bot-badge')!.classList.contains('hidden'));
        assert.match(botCard.querySelector('.player-class')!.textContent!, /RUN N GUN · MOBILITY/);
        assert.equal(botCard.querySelector('.ready-state')!.textContent, '✓ READY');
        assert.equal(friend.querySelector('.ready-state')!.textContent, '○ NOT READY');
        b.team = 'blue'; b.classId = 'vince'; b.ready = true; ui.updateLobby();
        assert.equal(card(b.id), friend);
        assert.equal(friend.parentElement!.id, 'blue-roster');
        assert.match(friend.querySelector('.player-class')!.textContent!, /VINCE/);
        assert.equal(document.getElementById('ready-count')!.textContent, '2 / 2');
        assert.match(document.getElementById('waiting-players')!.textContent!, /EVERYONE IS READY/);
        net.round!.mode = 'ffa'; ui.updateLobby();
        assert.equal(card(a.id), self); assert.equal(card(b.id), friend);
        assert.equal(document.getElementById('ffa-roster')!.children.length, 3);
        assert.equal(document.getElementById('ffa-count')!.textContent, '3');
        assert.ok(document.getElementById('team-blue')!.classList.contains('hidden'));
        assert.ok(!document.getElementById('team-ffa')!.classList.contains('hidden'));
        assert.ok(friend.querySelector('.move-player')!.classList.contains('hidden'));
        net.players.delete(b.id); ui.updateLobby();
        assert.equal(friend.isConnected, false);
        assert.equal(document.getElementById('ffa-count')!.textContent, '2');
    } finally { restore(); }
});

test('team click and host move controls use distinct targets and class changes retain a host-assigned team', () => {
    const { dom, restore, ui, net, a, b } = setup();
    try {
        net.round!.mode = 'tdm'; ui.updateLobby();
        const sent: ClientMessage[] = []; net.send = message => { sent.push(message); };
        document.getElementById('red-empty')!.click();
        assert.deepEqual(sent.pop(), { type: 'team', team: 'red' });
        const move = document.querySelector<HTMLButtonElement>(`[data-player-id="${b.id}"] .move-player`)!;
        move.click();
        assert.deepEqual(sent, [{ type: 'team', playerId: b.id, team: 'blue' }], 'move does not bubble into self switch');
        move.focus(); b.team = 'blue'; ui.updateLobby();
        assert.equal(document.activeElement, move, 'host can keep using the moved card with a keyboard');
        a.team = 'red';
        ui.choose('vince');
        assert.deepEqual(sent.at(-1), { type: 'class', classId: 'vince' }, 'class selection cannot overwrite a host assignment with stale client state');
        ui.updateLobby(); assert.equal(ui.team, 'red');
        net.host = b.id; ui.updateLobby();
        assert.ok(move.classList.contains('hidden'));
        sent.length = 0; move.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
        assert.deepEqual(sent, [], 'stale host control cannot move another player');
        net.host = a.id; net.round!.phase = 'playing'; ui.updateLobby();
        assert.equal(move.disabled, true);
        assert.equal(document.querySelector<HTMLButtonElement>('[data-team="blue"]')!.disabled, true);
        assert.equal(document.getElementById('deploy-label')!.textContent, 'JOIN MATCH');
        net.round!.phase = 'lobby'; ui.updateLobby();
        assert.equal(move.disabled, false);
        assert.equal(document.getElementById('deploy-label')!.textContent, 'READY UP');
    } finally { restore(); }
});
