import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { Network } from '../src/client/network';
import { UI } from '../src/client/ui';
import type { Renderer } from '../src/client/renderer';
import { createGameServer } from '../src/server/index';
import { moveState, neutralInput } from '../src/shared/movement';
import { WIRE_PROTOCOL } from '../src/shared/protocol';
import type { GameEvent } from '../src/shared/types';
import { installDOM } from './dom';

test('an authoritative headshot travels over the live binary socket into the shooter HUD only', async () => {
    const app = createGameServer();
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address();
    assert.ok(address && typeof address === 'object');
    const env = installDOM(`http://127.0.0.1:${address.port}`);
    const savedSocket = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
    Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: WebSocket });
    const shooter = new Network(), victim = new Network();
    const style = document.createElement('style');
    style.textContent = readFileSync(new URL('../src/client/style.css', import.meta.url), 'utf8');
    document.head.append(style);
    const ui = new UI(shooter);
    ui.menu = false; ui.visibility();
    const renderer = { fps: 60, viewmodel: { aim: 0 }, project: () => ({ x: 512, y: 280, visible: true }) } as unknown as Renderer;
    let shooterHits = 0;
    const victimEvents: GameEvent[] = [];
    // This is the production main.ts forwarding path, using the actual Network decoder.
    shooter.onEvents = events => {
        for (const event of events) {
            ui.event(event, renderer, 100);
            if (event.type === 'hit') shooterHits++;
        }
    };
    victim.onEvents = events => { victimEvents.push(...events); };
    const wait = async (condition: () => boolean, label: string) => {
        const deadline = Date.now() + 4000;
        while (!condition()) {
            assert.ok(Date.now() < deadline, label);
            await delay(10);
        }
    };
    try {
        shooter.connect({ name: 'Alpha', room: '', classId: 'hunter', team: 'blue', create: true });
        await wait(() => shooter.status === 'CONNECTED', 'shooter joins');
        const room = app.rooms.get(shooter.room)!;
        room.botCount = 0; room.fillBots(Date.now());
        // A second browser tab has its own session storage and must not resume Alpha's token.
        sessionStorage.clear();
        victim.connect({ name: 'Bravo', room: shooter.room, classId: 'hunter', team: 'red' });
        await wait(() => victim.status === 'CONNECTED' && shooter.players.has(victim.id), 'victim joins');
        assert.notEqual(shooter.id, victim.id);
        assert.equal(shooter.ws?.protocol, WIRE_PROTOCOL);
        assert.equal(victim.ws?.protocol, WIRE_PROTOCOL);
        room.round.mode = 'tdm';
        const now = Date.now();
        room.start(now);
        const a = room.players.get(shooter.id)!, b = room.players.get(victim.id)!;
        // Only the in-process fixture controls placement; no production test endpoint is needed.
        Object.assign(a.state, moveState(32, 0, 15), { yaw: 0, pitch: 0, protectionEnd: 0 });
        Object.assign(b.state, moveState(32, 0, 0), { protectionEnd: 0 });
        a.aimTime = 1; a.nextShot = 0;
        room.history.record(now, [a.state, b.state]);
        room.fire(a, { ...neutralInput(1), shotTime: now }, now);
        await wait(() => shooterHits === 1 && victimEvents.some(e => e.type === 'kill') && shooter.round?.blue === 1, 'combat events and team score arrive over both sockets');
        ui.update(100, renderer, false);
        const damage = document.querySelector('#damage-numbers > span')!;
        assert.equal(damage.textContent, '+100');
        assert.equal(window.getComputedStyle(damage).color, 'rgb(255, 229, 82)');
        assert.equal(window.getComputedStyle(document.getElementById('hitmarker')!).opacity, '1');
        assert.equal(document.getElementById('kill-notice')!.textContent, 'HEADSHOT+50');
        assert.equal(window.getComputedStyle(document.querySelector('#kill-notice > span')!).color, 'rgb(255, 255, 255)');
        assert.equal(window.getComputedStyle(document.querySelector('#kill-notice > strong')!).color, 'rgb(255, 229, 82)');
        assert.equal(document.querySelector('#team-scores .blue b')!.textContent, '1');
        assert.equal(window.getComputedStyle(document.getElementById('score-top')!).display, 'none');
        // Both clients receive the same event; only the shooter gets personal hit/kill feedback.
        const victimUI = new UI(victim);
        victimUI.menu = false; victimUI.visibility();
        for (const event of victimEvents) victimUI.event(event, renderer, 100);
        victimUI.update(100, renderer, false);
        assert.equal(document.getElementById('damage-numbers')!.childElementCount, 0);
        assert.equal(document.getElementById('kill-notice')!.textContent, '');
        assert.equal(window.getComputedStyle(document.getElementById('hitmarker')!).opacity, '0');
    } finally {
        shooter.disconnect(); victim.disconnect();
        await app.close();
        env.restore();
        if (savedSocket) Object.defineProperty(globalThis, 'WebSocket', savedSocket);
        else Reflect.deleteProperty(globalThis, 'WebSocket');
    }
});
