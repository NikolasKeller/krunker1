import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { createGameServer } from '../src/server/index';
import { decodeServerMessage, encodeClientMessage, WIRE_PROTOCOL } from '../src/shared/protocol';
import type { ServerMessage } from '../src/shared/types';

test('real sockets broadcast authenticated chat only inside the room, with length and rate limits', async () => {
    const app = createGameServer(), sockets: WebSocket[] = [];
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address(); assert.ok(address && typeof address !== 'string');
    async function join(room: string, name: string) {
        const ws = new WebSocket(`ws://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/ws`, WIRE_PROTOCOL);
        sockets.push(ws);
        const messages: ServerMessage[] = [];
        ws.on('message', (data, binary) => messages.push(decodeServerMessage(binary ? data as Buffer : data.toString())));
        await once(ws, 'open');
        ws.send(encodeClientMessage({ type: 'join', room, name, classId: 'hunter', team: 'blue' }));
        const end = Date.now() + 3000;
        while (!messages.some(m => m.type === 'welcome')) { assert.ok(Date.now() < end, 'join timeout'); await delay(10); }
        return { ws, messages, chats: () => messages.filter(m => m.type === 'chat') };
    }
    try {
        const a = await join('CHAT', 'Alpha'), b = await join('CHAT', 'Bravo'), other = await join('OTHER', 'Charlie');
        a.ws.send(JSON.stringify({ type: 'chat', text: '  Hello\n room  ', name: 'Spoof', team: 'red' }));
        const end = Date.now() + 3000;
        while (!b.chats().length) { assert.ok(Date.now() < end, 'chat broadcast timeout'); await delay(10); }
        assert.equal(a.chats()[0].text, 'Hello room');
        assert.equal(b.chats()[0].name, 'Alpha'); assert.equal(b.chats()[0].team, 'blue');
        assert.equal(other.chats().length, 0);
        a.ws.send(encodeClientMessage({ type: 'chat', text: 'spam' })); await delay(100);
        assert.equal(b.chats().length, 1);
        await delay(750);
        a.ws.send(encodeClientMessage({ type: 'chat', text: 'x'.repeat(200) }));
        const next = Date.now() + 3000;
        while (b.chats().length < 2) { assert.ok(Date.now() < next, 'second chat timeout'); await delay(10); }
        assert.equal(b.chats()[1].text.length, 160);
        assert.equal(other.chats().length, 0);
    } finally { sockets.forEach(ws => ws.terminate()); await app.close(); }
});
