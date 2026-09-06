import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { UI } from '../src/client/ui';
import type { Network } from '../src/client/network';
import { Room } from '../src/server/simulation';
import { createGameServer } from '../src/server/index';
import { MAPS } from '../src/shared/map';
import { decodeServerMessage, WIRE_PROTOCOL } from '../src/shared/protocol';
import type { ClientMessage, RoundState } from '../src/shared/types';
import { installDOM } from './dom';

test('lobby exposes all maps and random; guests and mobile layouts see the resolved map before ready-up', () => {
    const { dom, restore } = installDOM();
    try {
        const room = new Room('LOBBY', 'random', () => .3), a = room.add('Host', 'hunter', 'blue').state;
        const sent: ClientMessage[] = [];
        const net = { id: a.id, host: a.id, room: room.id, ws: {}, status: 'CONNECTED', round: room.round,
            players: new Map([[a.id, a]]), local: a, serverNow: 1, difficulty: 'normal', bots: 0,
            send(message: ClientMessage) { sent.push(message); } } as unknown as Network;
        const ui = new UI(net); ui.updateLobby();
        const select = document.getElementById('map-choice') as HTMLSelectElement;
        assert.deepEqual([...select.options].map(o => o.value), ['random', ...MAPS.map(m => m.id)]);
        assert.equal(select.value, 'random'); assert.equal(select.disabled, false);
        assert.equal(document.getElementById('map-name')!.textContent, 'ORBITAL');
        assert.equal(document.getElementById('map-current')!.textContent, 'THIS ROUND · ORBITAL');
        assert.ok(!document.getElementById('map-current')!.closest('.map-thumb'), 'selected map stays visible when touch CSS hides artwork');
        select.value = 'abyss'; select.dispatchEvent(new dom.window.Event('change'));
        assert.deepEqual(sent.at(-1), { type: 'configure', map: 'abyss' });
        room.configureMap(a.id, 'abyss', 2); ui.updateLobby();
        assert.equal(document.getElementById('map-current')!.textContent, 'THIS ROUND · ABYSS');
        net.host = 'someone-else'; ui.updateLobby(); assert.equal(select.disabled, true);
        assert.equal(select.value, 'abyss');
        net.host = a.id; room.start(3); ui.updateLobby(); assert.equal(select.disabled, true);
    } finally { restore(); }
});

test('live host selection is authoritative and broadcasts all five maps to guests and late arrivals', async () => {
    const app = createGameServer(), sockets: WebSocket[] = [];
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address(); assert.ok(address && typeof address === 'object');
    const wait = async (condition: () => boolean) => {
        const deadline = Date.now() + 5000;
        while (!condition()) { assert.ok(Date.now() < deadline, 'map metadata did not arrive'); await delay(10); }
    };
    const join = async (room = '') => {
        const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, WIRE_PROTOCOL); sockets.push(ws);
        const client: { ws: WebSocket; id: string; room: string; round?: RoundState } = { ws, id: '', room };
        ws.on('message', (data, binary) => {
            const message = decodeServerMessage(binary ? new Uint8Array(data as Buffer) : data.toString());
            if (message.type === 'welcome') { client.id = message.id; client.room = message.room; }
            if (message.type === 'snapshot' && message.round) client.round = message.round;
        });
        await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
        ws.send(JSON.stringify({ type: 'join', name: room ? 'Guest' : 'Host', classId: 'hunter', team: room ? 'red' : 'blue', room, create: !room }));
        await wait(() => !!client.round);
        return client;
    };
    try {
        const host = await join(), guest = await join(host.room);
        assert.equal(host.round!.mapChoice, 'random');
        assert.equal(guest.round!.mapId, host.round!.mapId);
        for (const map of MAPS) {
            host.ws.send(JSON.stringify({ type: 'configure', map: map.id, bots: 0 }));
            await wait(() => host.round?.mapId === map.id && guest.round?.mapId === map.id && host.round.mapChoice === map.id);
            assert.equal(app.rooms.get(host.room)!.map.id, map.id);
        }
        guest.ws.send(JSON.stringify({ type: 'configure', map: 'sandyard' }));
        await delay(100);
        assert.equal(app.rooms.get(host.room)!.map.id, 'catacomb');
        const late = await join(host.room);
        assert.equal(late.round!.mapId, 'catacomb');
        host.ws.send(JSON.stringify({ type: 'configure', map: 'random' }));
        await wait(() => [host, guest, late].every(c => c.round?.mapChoice === 'random'));
        assert.equal(host.round!.mapId, guest.round!.mapId); assert.equal(host.round!.mapId, late.round!.mapId);
    } finally {
        for (const socket of sockets) socket.terminate();
        await app.close();
    }
});
