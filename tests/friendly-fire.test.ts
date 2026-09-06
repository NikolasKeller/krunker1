import assert from 'node:assert/strict';
import test from 'node:test';
import { Scene } from 'three';
import { Room } from '../src/server/simulation';
import { Effects } from '../src/client/effects';
import { ShotFeedback } from '../src/client/shot-feedback';
import { Network } from '../src/client/network';
import { moveState, neutralInput } from '../src/shared/movement';
import { WEAPONS } from '../src/shared/weapons';
import type { Mode } from '../src/shared/types';

function fixture(mode: Mode, teammate: boolean, bot = false) {
    const room = new Room('TEAMS'); room.botCount = 0; room.round.mode = mode;
    const shooter = room.add('Shooter', 'triggerman', 'blue', bot), target = room.add('Target', 'triggerman', teammate ? 'blue' : 'red');
    room.start(0);
    Object.assign(shooter.state, moveState(34, 0, 20), { yaw: 0, pitch: -.062 });
    Object.assign(target.state, moveState(34, 0, 10));
    const input = { ...neutralInput(1), yaw: shooter.state.yaw, pitch: shooter.state.pitch, life: shooter.state.life, fire: true, shotTime: 1000, interpolationDelay: 100 };
    room.history.record(1000, [shooter.state, target.state]);
    return { room, shooter, target, input };
}

for (const bot of [false, true]) for (const mode of ['tdm', 'ffa'] as const) for (const teammate of [false, true]) {
    test(`${bot ? 'bot' : 'human'}: ${mode} ${teammate ? 'same' : 'other'} team damage and feedback`, () => {
        const { room, shooter, target, input } = fixture(mode, teammate, bot);
        let hits = 0, sounds = 0;
        const feedback = new ShotFeedback(new Effects(new Scene()), { fire() {} }, { shot() {}, hit() { sounds++; } });
        feedback.onHit = () => { hits++; };
        feedback.fire({ ...shooter.state }, input, 0, 0, { x: 34, y: 1.62, z: 20 }, [target.state], mode);
        room.onCombat = m => feedback.resolve(m);
        room.fire(shooter, input, 1100);
        const allowed = mode === 'ffa' || !teammate;
        assert.equal(target.state.hp, 100 - (allowed ? WEAPONS.rifle.damage : 0));
        assert.equal(room.events.filter(e => e.type === 'hit').length, allowed ? 1 : 0);
        assert.equal(room.events.filter(e => e.type === 'kill').length, 0);
        assert.equal(hits, allowed ? 1 : 0, 'no provisional hitmarker/damage-number callback for teammates');
        assert.equal(sounds, allowed ? 1 : 0, 'no teammate hit sound');
        assert.equal(feedback.metrics.disagreements, 0);
        assert.equal(shooter.state.ammo, WEAPONS.rifle.magazine - 1);
    });
}

test('teammate hitboxes still rewind and stop a shot before an enemy behind them', t => {
    const { room, shooter, target, input } = fixture('tdm', true);
    const behind = room.add('Behind', 'triggerman', 'red'); Object.assign(behind.state, moveState(34, 0, 5));
    const feedback = new ShotFeedback(new Effects(new Scene()), { fire() {} }, { shot() {}, hit() { assert.fail('teammate produced a hit sound'); } });
    feedback.onHit = () => assert.fail('teammate ray predicted damage to the enemy behind');
    feedback.fire({ ...shooter.state }, input, 0, 0, { x: 34, y: 1.62, z: 20 }, [target.state, behind.state], 'tdm');
    target.state.x = 30; // The teammate used to be on the ray when it was fired.
    const rewind = t.mock.method(room.history, 'rewind');
    room.fire(shooter, input, 1100);
    assert.ok(rewind.mock.calls.some(c => c.arguments[0] === target.state.id));
    assert.equal(target.state.hp, 100); assert.equal(behind.state.hp, 100);
    const shot = room.events.find(e => e.type === 'shot')!;
    assert.ok(shot.type === 'shot' && shot.ends[0].z > 10 && shot.ends[0].z < 11);
    assert.equal(room.events.filter(e => e.type === 'hit').length, 0);
});

test('rendered team eligibility follows current authority while positions use history', t => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const { shooter, target, input } = fixture('tdm', false), net = new Network();
    t.after(() => net.disconnect());
    net.id = shooter.state.id;
    net.frames = [{ time: 1000, players: new Map([[target.state.id, { ...target.state }]]) }];
    net.players = new Map([[target.state.id, { ...target.state, team: 'blue' }]]);
    const remotes = net.remotePlayers();
    assert.equal(remotes[0].team, 'blue');
    const feedback = new ShotFeedback(new Effects(new Scene()), { fire() {} }, { shot() {}, hit() { assert.fail('old team produced a hit sound'); } });
    feedback.onHit = () => assert.fail('old team produced predicted damage');
    feedback.fire({ ...shooter.state }, input, 0, 0, { x: 34, y: 1.62, z: 20 }, remotes, 'tdm');
});

test('queued shots use teams at validation, in both switch directions', () => {
    for (const teammate of [false, true]) {
        const { room, shooter, target, input } = fixture('tdm', teammate);
        assert.ok(room.enqueue(shooter, [input], 1050));
        assert.ok(room.moveTeam(target.state.id, target.state.id, teammate ? 'red' : 'blue', 1075));
        // Team selection moves to spawn and invalidates the old pose. Put the
        // current-life target on the ray to isolate team eligibility from range.
        Object.assign(target.state, moveState(34, 0, 10));
        room.tick(1100);
        assert.equal(target.state.hp, teammate ? 100 - WEAPONS.rifle.damage : 100);
    }
});

test('rewound team metadata cannot override live team eligibility or enemy registration', () => {
    for (const teammate of [false, true]) {
        const { room, shooter, target, input } = fixture('tdm', teammate);
        target.state.team = teammate ? 'red' : 'blue';
        target.state.x = 30;
        room.fire(shooter, input, 1100);
        assert.equal(target.state.hp, teammate ? 100 - WEAPONS.rifle.damage : 100);
    }
});
