import assert from 'node:assert/strict';
import test from 'node:test';
import { Room } from './sandyard-room';
import { COUNTDOWN_MS } from '../src/shared/types';

function lobby() {
    const room = new Room('READY'); room.botCount = 0;
    const a = room.add('Alpha', 'hunter', 'blue'), b = room.add('Bravo', 'hunter', 'red');
    return { room, a, b };
}

test('all connected humans must be ready; bots and disconnected humans do not vote', () => {
    const { room, a, b } = lobby();
    const bot = room.add('Bot', 'hunter', 'red', true);
    a.state.ready = true; room.updateLobby(1000);
    assert.equal(room.round.phase, 'lobby');
    b.connected = false; room.updateLobby(1100);
    assert.equal(bot.state.ready, false);
    assert.equal(room.round.phase, 'countdown');
    assert.equal(room.round.nextAt, 1100 + COUNTDOWN_MS);
});

test('all-ready countdown preserves its deadline and starts exactly one round', () => {
    const { room, a, b } = lobby();
    a.state.ready = b.state.ready = true;
    room.updateLobby(1000); const deadline = room.round.nextAt;
    for (let now = 1001; now < deadline; now += 17) room.updateLobby(now);
    assert.equal(room.round.nextAt, deadline); assert.equal(room.round.phase, 'countdown');
    room.updateLobby(deadline);
    assert.equal(room.round.phase, 'playing'); assert.equal(room.round.round, 1);
    assert.equal(room.round.endsAt, deadline + room.round.duration);
    assert.ok(!a.state.ready && !b.state.ready);
    room.updateLobby(deadline + 100); assert.equal(room.round.round, 1);
});

test('unready cancels an automatic countdown and ready starts a fresh full countdown', () => {
    const { room, a, b } = lobby(); a.state.ready = b.state.ready = true;
    room.updateLobby(1000); b.state.ready = false; room.updateLobby(1500);
    assert.equal(room.round.phase, 'lobby'); assert.equal(room.round.nextAt, 0);
    room.updateLobby(1000 + COUNTDOWN_MS); assert.equal(room.round.phase, 'lobby');
    b.state.ready = true; room.updateLobby(5000);
    assert.equal(room.round.nextAt, 5000 + COUNTDOWN_MS);
});

test('new unready arrival cancels an automatic countdown; leaving resumes it', () => {
    const { room, a, b } = lobby(); a.state.ready = b.state.ready = true; room.updateLobby(1000);
    const c = room.add('Charlie', 'hunter', 'blue'); room.updateLobby(1500);
    assert.equal(room.round.phase, 'lobby');
    c.connected = false; room.updateLobby(2000);
    assert.equal(room.round.phase, 'countdown'); assert.equal(room.round.nextAt, 2000 + COUNTDOWN_MS);
});

test('start early includes unready humans but cancels if everyone leaves', () => {
    const { room, a, b } = lobby(); room.countdown(1000, true);
    room.updateLobby(2000); assert.equal(room.round.phase, 'countdown');
    room.updateLobby(1000 + COUNTDOWN_MS); assert.equal(room.round.phase, 'playing');
    assert.ok(a.state.alive && b.state.alive);
    const empty = lobby(); empty.room.countdown(1000, true);
    empty.a.connected = empty.b.connected = false; empty.room.updateLobby(1500);
    assert.equal(empty.room.round.phase, 'lobby'); assert.equal(empty.room.forcedCountdown, false);
    empty.room.updateLobby(1000 + COUNTDOWN_MS); assert.equal(empty.room.round.round, 0);
});

test('settings reset readiness and cancel even a forced countdown', () => {
    const { room, a, b } = lobby(); a.state.ready = b.state.ready = true;
    room.countdown(1000, true); room.resetReady(); room.updateLobby(5000);
    assert.equal(room.round.phase, 'lobby'); assert.equal(room.round.nextAt, 0);
    assert.ok(!a.state.ready && !b.state.ready);
});

test('results return to the same lobby with fresh readiness, and rematches reset scores', () => {
    const { room, a, b } = lobby(); a.state.ready = b.state.ready = true;
    room.updateLobby(1000); room.updateLobby(1000 + COUNTDOWN_MS);
    a.state.kills = room.round.scoreLimit; a.state.score = 500; room.tick(5000);
    assert.equal(room.round.phase, 'results'); assert.equal(room.round.results?.[0].id, a.state.id);
    assert.ok(!a.state.ready && !b.state.ready);
    const nextAt = room.round.nextAt; room.tick(nextAt);
    assert.equal(room.round.phase, 'lobby'); assert.equal(room.round.results?.[0].score, 500);
    room.tick(nextAt + 10000); assert.equal(room.round.phase, 'lobby');
    a.state.ready = b.state.ready = true; room.updateLobby(nextAt + 11000);
    room.updateLobby(nextAt + 11000 + COUNTDOWN_MS);
    assert.equal(room.round.round, 2); assert.equal(room.round.phase, 'playing');
    assert.equal(a.state.kills, 0); assert.equal(a.state.score, 0); assert.equal(room.round.results, undefined);
});
