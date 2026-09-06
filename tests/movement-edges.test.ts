import assert from 'node:assert/strict';
import test from 'node:test';
import { edgeSession } from './movement-edge-session';
import { move, moveState, neutralInput, MAX_SPEED, JUMP_SPEED, GRAVITY } from '../src/shared/movement';
import { STEP } from '../src/shared/types';

test('all map faces, corners and ramp junctions at maximum run/slide/hop speed conserve collision energy', () => {
    const report = edgeSession();
    assert.ok(report.cases > 5800);
    assert.equal(report.velocityViolations, 0, JSON.stringify(report.failures));
    assert.equal(report.displacementViolations, 0, JSON.stringify(report.failures));
    assert.equal(report.penetrations, 0, JSON.stringify(report.failures));
    assert.equal(report.sideRise, 0, 'ramp side is a wall, not a 0.552 m step');
    assert.ok(Math.abs(report.airborneRampRise - .01) < 1e-9, 'airborne height changes only by existing velocity/gravity');
    assert.equal(report.stepHeight, .3, 'small steps retain support throughout all substeps');
    assert.ok(report.stepX > -1.5, 'stepping cannot eject the player back to the entry face');
});

test('ramp side contact cannot turn a held/buffered hop into another launch', () => {
    const p = { ...moveState(-14, .35, -3.881), vy: 1, vz: MAX_SPEED, grounded: false };
    let airborne = true;
    for (let tick = 0; tick < 60; tick++) {
        const before = { ...p };
        move(p, { ...neutralInput(tick), jump: true, forward: 1, yaw: Math.PI });
        if (airborne && !before.grounded) assert.ok(p.vy <= Math.max(0, before.vy - GRAVITY * STEP) + 1e-8);
        if (p.grounded) airborne = false;
        assert.ok(p.vy <= JUMP_SPEED);
    }
});
