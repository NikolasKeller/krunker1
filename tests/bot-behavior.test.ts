import assert from 'node:assert/strict';
import test from 'node:test';
import { botInput, brain } from '../src/server/bots';
import { Room } from '../src/server/simulation';
import { moveState } from '../src/shared/movement';

function fixture() {
    const room = new Room('PERCEPTION'); room.botCount = 0;
    const bot = room.add('Bot', 'triggerman', 'blue', true), target = room.add('Target', 'triggerman', 'red');
    room.start(0);
    Object.assign(bot.state, moveState(34, 0, 20), { yaw: 0, pitch: 0 });
    Object.assign(target.state, moveState(34, 0, 0));
    return { room, bot, target };
}

for (const difficulty of ['easy', 'normal', 'hard'] as const) {
    test(`${difficulty}: cover hides movement, reacquisition requires a new reaction, and memory expires`, t => {
        t.mock.method(Math, 'random', () => .5);
        const { bot, target } = fixture(), b = brain(), players = [bot.state, target.state];
        assert.equal(botInput(bot.state, b, players, 'tdm', difficulty, 1000).fire, false);
        assert.equal(botInput(bot.state, b, players, 'tdm', difficulty, 1600).fire, true);
        const observed = { x: 34, y: 0, z: 0 };
        // The large eastern building occludes both of these legal positions.
        target.state.x = 19;
        assert.equal(botInput(bot.state, b, players, 'tdm', difficulty, 1700).fire, false);
        assert.equal(b.target, '');
        assert.deepEqual(b.lastSeen?.position, observed);
        const frozen = structuredClone(b);
        const a = botInput(bot.state, b, players, 'tdm', difficulty, 2400);
        target.state.x = 15;
        const c = botInput(bot.state, frozen, players, 'tdm', difficulty, 2400);
        assert.deepEqual(a, c, 'unseen movement changes neither aim nor navigation');
        assert.deepEqual(b.path, frozen.path);
        botInput(bot.state, b, players, 'tdm', difficulty, 3700);
        assert.equal(b.lastSeen, undefined);
        target.state.x = 34;
        assert.equal(botInput(bot.state, b, players, 'tdm', difficulty, 4000).fire, false);
        assert.equal(botInput(bot.state, b, players, 'tdm', difficulty, 4200).fire, false);
        assert.equal(botInput(bot.state, b, players, 'tdm', difficulty, 4600).fire, true);
    });

    test(`${difficulty}: never-seen opponents cannot affect patrol and teammates are not acquired`, t => {
        t.mock.method(Math, 'random', () => .5);
        const { bot, target } = fixture(); target.state.x = 19;
        const b = brain(), empty = brain();
        assert.deepEqual(botInput(bot.state, b, [bot.state, target.state], 'tdm', difficulty, 1000), botInput(bot.state, empty, [bot.state], 'tdm', difficulty, 1000));
        assert.deepEqual(b.path, empty.path);
        target.state.x = 34; target.state.team = 'blue';
        assert.equal(botInput(bot.state, b, [bot.state, target.state], 'tdm', difficulty, 2000).fire, false);
        assert.equal(b.target, '');
    });
}

test('bot respawn clears target reaction and hidden-position memory', () => {
    const { room, bot, target } = fixture();
    botInput(bot.state, bot.botBrain!, [bot.state, target.state], 'tdm', 'normal', 1000);
    assert.equal(bot.botBrain!.target, target.state.id);
    room.spawn(bot, 2000);
    assert.equal(bot.botBrain!.target, ''); assert.equal(bot.botBrain!.lastSeen, undefined);
});
