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
