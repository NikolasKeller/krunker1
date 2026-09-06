import assert from 'node:assert/strict';
import test from 'node:test';
import { Room } from './sandyard-room';
import { moveState, neutralInput } from '../src/shared/movement';

function fixture() {
    const room = new Room('FAIR'); room.botCount = 0;
    const shooter = room.add('Shooter', 'triggerman', 'blue');
    const target = room.add('Target', 'triggerman', 'red');
    room.start(1000);
    Object.assign(shooter.state, moveState(34, 0, 20), { yaw: 0, pitch: -.05 });
    Object.assign(target.state, moveState(34, 0, 10));
    return { room, shooter, target };
}

test('a freshly spawned player takes server damage without firing or waiting for immunity', () => {
    const { room, shooter, target } = fixture();
    const hp = target.state.hp;
    room.fire(shooter, { ...neutralInput(1), shotTime: 1001 }, 1001);
    assert.ok(target.state.hp < hp, `fresh spawn: ${hp} -> ${target.state.hp}`);
});

test('an obsolete rewound life cannot remove the current player hitbox', () => {
    const { room, shooter, target } = fixture();
    target.state.protectionEnd = 0;
    room.history.record(3000, [shooter.state, target.state]);
    room.spawn(target, 3100);
    Object.assign(target.state, moveState(34, 0, 10), { protectionEnd: 0 });
    const hp = target.state.hp;
    room.fire(shooter, { ...neutralInput(1), shotTime: 3000, interpolationDelay: 100 }, 3100);
    assert.ok(target.state.hp < hp, `new life against old history: ${hp} -> ${target.state.hp}`);
});

test('class/team changes cannot heal, refill ammo, shorten death or bypass a shot cooldown', () => {
    const { room, shooter: a } = fixture();
    a.state.hp = 17; a.state.ammo = 4; a.nextShot = 5000;
    const origin = { x: a.state.x, y: a.state.y, z: a.state.z };
    assert.ok(room.changeClass(a, 'hunter', 2000));
    assert.equal(a.state.weapon, 'sniper'); assert.equal(a.state.hp, 17);
    assert.deepEqual({ x: a.state.x, y: a.state.y, z: a.state.z }, origin, 'class does not teleport');
    assert.ok(room.changeClass(a, 'triggerman', 2001));
    assert.equal(a.state.ammo, 4); assert.equal(a.spawnFireAt, 5000);
    assert.ok(room.moveTeam(a.state.id, a.state.id, 'red', 2002));
    assert.equal(a.state.hp, 17); assert.equal(a.state.ammo, 4); assert.equal(a.nextShot, 5000);
    const life = a.state.life;
    for (let n = 0; n < 10; n++) room.changeClass(a, 'triggerman', 2100 + n);
    assert.equal(a.state.life, life, 'duplicate class is a no-op');
    Object.assign(a.state, { alive: false, hp: 0, respawnAt: 8000 });
    room.changeClass(a, 'vince', 2200); room.moveTeam(a.state.id, a.state.id, 'blue', 2300);
    assert.equal(a.state.hp, 0); assert.equal(a.state.alive, false); assert.equal(a.state.respawnAt, 8000);
});

test('a stale life position never transfers damage to a new life at another position', () => {
    const { room, shooter, target } = fixture();
    room.history.record(3000, [shooter.state, target.state]);
    room.spawn(target, 3100);
    Object.assign(target.state, moveState(30, 0, 10));
    room.fire(shooter, { ...neutralInput(1), shotTime: 3000, interpolationDelay: 100 }, 3100);
    assert.equal(target.state.hp, 100);
});
