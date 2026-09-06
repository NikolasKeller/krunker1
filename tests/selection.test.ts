import assert from 'node:assert/strict';
import test from 'node:test';
import { Room } from '../src/server/simulation';
import { Network } from '../src/client/network';
import { UI } from '../src/client/ui';
import { Viewmodel } from '../src/client/viewmodel';
import type { Renderer } from '../src/client/renderer';
import type { ClientMessage, PlayerState, ServerMessage, Team } from '../src/shared/types';
import { decodeClientMessage, decodeServerMessage, encodeServerMessage } from '../src/shared/protocol';
import { CLASSES, WEAPONS } from '../src/shared/weapons';
import { SPAWNS } from '../src/shared/map';
import { installDOM } from './dom';
import { assertVisibleWeapon } from './viewmodel-fixture';

for (const phase of ['lobby', 'playing'] as const) for (const order of ['team', 'class', 'team-class', 'class-team', 'class-class-team'] as const) {
    test(`${phase}: ${order} is visible immediately and survives stale, intermediate and acknowledged snapshots`, t => {
        t.mock.timers.enable({ apis: ['setInterval'] });
        const env = installDOM(), net = new Network(), room = new Room('SELECT'); room.botCount = 0; room.round.mode = 'tdm';
        const a = room.add('Self', 'triggerman', 'blue'), b = room.add('Friend', 'hunter', 'red');
        if (phase === 'playing') room.start(1000);
        a.state.hp = 67; a.state.ammo = 4;
        const sent: ClientMessage[] = [];
        const socket = { readyState: 1, bufferedAmount: 0, send: (data: string | Uint8Array) => sent.push(decodeClientMessage(data)), close() {} };
        const previous = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
        Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: { OPEN: 1 } });
        net.ws = socket as unknown as WebSocket; net.id = a.state.id; net.room = room.id; net.host = a.state.id;
        const receive = (message: ServerMessage) => (net as unknown as { receive(message: ServerMessage): void }).receive(decodeServerMessage(encodeServerMessage(message, net.id)));
        let n = 0, ui: UI, now = 2000;
        function snapshot(state: PlayerState, selectionAck?: number) {
            receive({ type: 'snapshot', full: true, n: ++n, base: 0, time: ++now, players: [{ ...state }, { ...b.state }], removed: [], round: { ...room.round }, selectionAck });
        }
        try {
            snapshot(a.state, 0); ui = new UI(net); ui.menu = false; ui.scoreOpen = true; ui.updateLobby();
            const vm = new Viewmodel(), renderer = { fps: 60, viewmodel: vm, project: () => ({ x: 400, y: 300, visible: true }) } as unknown as Renderer;
            const old = { ...a.state };
            let expectedClass = a.state.classId, expectedTeam: Team = 'blue';
            function visible() {
                ui.updateLobby();
                const p = net.predicted!;
                if (vm.weapon !== p.weapon) vm.setWeapon(p.weapon);
                vm.update(1 / 60, 0, 0, false, 0, now, 0); assertVisibleWeapon(vm);
                ui.update(now += 101, renderer, false, []);
                assert.equal(p.classId, expectedClass); assert.equal(p.team, expectedTeam);
                assert.equal(p.weapon, CLASSES[expectedClass].weapon); assert.equal(vm.weapon, p.weapon);
                assert.equal(document.getElementById('ammo')!.textContent, String(p.ammo));
                assert.equal(document.getElementById('hud-weapon')!.textContent, WEAPONS[p.weapon].name);
                assert.equal(document.querySelector('[data-class].selected')?.getAttribute('data-class'), expectedClass);
                assert.equal(document.querySelector('[data-team].selected')?.getAttribute('data-team'), expectedTeam);
                const card = document.querySelector(`[data-player-id="${a.state.id}"]`)!;
                assert.equal(card.parentElement!.id, `${expectedTeam}-roster`);
                assert.ok(card.querySelector('.player-class')!.textContent!.includes(CLASSES[expectedClass].name));
                const row = document.querySelector('#board-table tr.self')!;
                assert.ok(row.querySelector(`.roster-dot.${expectedTeam}`));
                assert.ok(row.textContent!.includes(CLASSES[expectedClass].name));
                assert.equal(document.getElementById('health')!.textContent, '67');
            }
            for (const step of order.split('-')) {
                if (step === 'team') {
                    expectedTeam = 'red'; document.querySelector<HTMLButtonElement>('[data-team="red"]')!.click();
                } else {
                    expectedClass = expectedClass === 'hunter' ? 'vince' : 'hunter';
                    document.querySelector<HTMLButtonElement>(`[data-class="${expectedClass}"]`)!.click();
                }
                const immediateCard = document.querySelector(`[data-player-id="${a.state.id}"]`)!;
                assert.equal(immediateCard.parentElement!.id, `${expectedTeam}-roster`, 'click updates lineup before its polling timer');
                assert.ok(immediateCard.querySelector('.player-class')!.textContent!.includes(CLASSES[expectedClass].name));
                visible(); snapshot(old, 0); visible();
            }
            for (const message of sent.filter(m => m.type === 'class' || m.type === 'team')) {
                if (message.type === 'class') assert.ok(room.changeClass(a, message.classId, now));
                else if (message.type === 'team') assert.ok(room.moveTeam(a.state.id, a.state.id, message.team, now));
                if (message.type === 'team') assert.ok(SPAWNS.some((s, i) => i % 2 === 1 && s.x === a.state.x && s.z === a.state.z), 'server uses red spawn side');
                snapshot(a.state, message.requestId); visible();
            }
            assert.equal(a.state.classId, expectedClass); assert.equal(a.state.team, expectedTeam);
            assert.equal(net.predicted!.ammo, a.state.ammo); assert.equal(a.state.hp, 67);
            snapshot(a.state); visible();
            const remotes = net.remotePlayers();
            assert.equal(remotes.find(p => p.id === b.state.id)?.team, 'red');
        } finally {
            net.disconnect(); env.restore();
            if (previous) Object.defineProperty(globalThis, 'WebSocket', previous); else Reflect.deleteProperty(globalThis, 'WebSocket');
        }
    });
}

test('pending class presentation never masks incoming server damage or death', t => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const net = new Network(), room = new Room('HEALTH'), a = room.add('Self', 'hunter', 'blue'); room.start(0);
    const original = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
    Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: { OPEN: 1 } });
    net.id = a.state.id; net.ws = { readyState: 1, send() {}, close() {} } as unknown as WebSocket;
    const receive = (m: ServerMessage) => (net as unknown as { receive(m: ServerMessage): void }).receive(m);
    const snapshot = (hp: number, alive: boolean) => receive({ type: 'snapshot', n: hp + 1, base: 0, full: true, time: 1000, players: [{ ...a.state, hp, alive }], removed: [], round: room.round, selectionAck: 0 });
    try {
        snapshot(100, true); net.send({ type: 'class', classId: 'vince' });
        snapshot(23, true); assert.equal(net.predicted!.hp, 23); assert.equal(net.predicted!.weapon, 'shotgun');
        snapshot(0, false); assert.equal(net.predicted!.hp, 0); assert.equal(net.predicted!.alive, false);
    } finally { net.disconnect(); if (original) Object.defineProperty(globalThis, 'WebSocket', original); else Reflect.deleteProperty(globalThis, 'WebSocket'); }
});

test('class cycling retains depleted ammo through selection acknowledgements; rejected selections roll back', t => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const env = installDOM(), net = new Network(), room = new Room('INVENTORY'), a = room.add('Self', 'triggerman', 'blue');
    room.start(0); a.state.ammo = 4;
    const before = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
    Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: { OPEN: 1 } });
    const sent: ClientMessage[] = [];
    net.id = a.state.id; net.ws = { readyState: 1, send(data: string) { sent.push(decodeClientMessage(data)); }, close() {} } as unknown as WebSocket;
    let n = 0;
    const snapshot = (selectionAck = 0) => (net as unknown as { receive(m: ServerMessage): void }).receive({ type: 'snapshot', n: ++n, base: 0, full: true, time: n * 50, players: [{ ...a.state }], removed: [], round: { ...room.round }, selectionAck });
    try {
        snapshot();
        for (const classId of ['hunter', 'triggerman'] as const) {
            net.send({ type: 'class', classId });
            assert.equal(net.predicted!.ammo, classId === 'hunter' ? 3 : 4);
            room.changeClass(a, classId, n * 50);
            const request = sent.at(-1)!; assert.equal(request.type, 'class');
            snapshot(request.requestId);
            assert.equal(net.predicted!.ammo, a.state.ammo);
        }
        net.send({ type: 'class', classId: 'vince' });
        assert.equal(net.predicted!.weapon, 'shotgun');
        room.round.phase = 'results';
        const request = sent.at(-1)!; assert.equal(request.type, 'class');
        assert.equal(room.changeClass(a, 'vince', n * 50), false);
        snapshot(request.requestId);
        assert.equal(net.predicted!.classId, 'triggerman'); assert.equal(net.predicted!.ammo, 4);
        assert.equal(net.changingClass, false);
    } finally { net.disconnect(); env.restore(); if (before) Object.defineProperty(globalThis, 'WebSocket', before); else Reflect.deleteProperty(globalThis, 'WebSocket'); }
});
