import assert from 'node:assert/strict';
import test from 'node:test';
import { Room } from './sandyard-room';
import { predictInput } from '../src/client/prediction';
import { moveState, neutralInput } from '../src/shared/movement';
import { MAX_INPUT_BATCH, MAX_PENDING_INPUTS } from '../src/shared/protocol';
import { STEP } from '../src/shared/types';

test('a four-second upload silence never applies physics without advancing the acknowledgement', () => {
    const room = new Room('IDLE'); room.botCount = 0; const actor = room.add('Jumper', 'hunter', 'blue'); room.start(0);
    Object.assign(actor.state, moveState(34, 0, 24));
    room.enqueue(actor, [{ ...neutralInput(1), forward: 1, jump: true }], 0); room.tick(0);
    const before = { ...actor.state };
    for (let tick = 1; tick <= 240; tick++) room.tick(tick * STEP * 1000);
    for (const key of Object.keys(moveState()) as (keyof ReturnType<typeof moveState>)[]) assert.equal(actor.state[key], before[key], key);
    assert.equal(actor.state.ack, 1);
});

test('four seconds of movement replay exactly; expired shots cannot fire during recovery', () => {
    const room = new Room('RECOVER'); room.botCount = 0; const actor = room.add('Walker', 'triggerman', 'blue'); room.start(1000);
    Object.assign(actor.state, moveState(34, 0, 24));
    const expected = { ...actor.state };
    for (let tick = 1; tick <= 240; tick++) room.tick(1000 + tick * STEP * 1000);
    let sequence = 0;
    for (let batch = 0; batch < 20; batch++) {
        const inputs = Array.from({ length: MAX_INPUT_BATCH }, () => ({ ...neutralInput(++sequence), life: actor.state.life, forward: sequence < 120 ? 1 : -1, jump: sequence === 40, slide: sequence > 80 && sequence < 100, fire: true, shotTime: 1000 }));
        for (const input of inputs) predictInput(expected, input, true);
        assert.ok(room.enqueue(actor, inputs, 5000));
    }
    for (let tick = 1; tick <= 20; tick++) {
        const ack = actor.state.ack; room.tick(5000 + tick * STEP * 1000);
        assert.equal(actor.state.ack - ack, MAX_INPUT_BATCH, 'catch-up work is bounded per tick, without gaps');
    }
    assert.equal(actor.state.ack, 240); assert.equal(actor.queue.length, 0);
    for (const key of Object.keys(moveState()) as (keyof ReturnType<typeof moveState>)[]) assert.equal(actor.state[key], expected[key], key);
    assert.equal(room.events.some(e => e.type === 'shot'), false);
    room.enqueue(actor, [{ ...neutralInput(241), fire: true, shotTime: 5333 }], 5350); room.tick(5350);
    assert.equal(room.events.filter(e => e.type === 'shot').length, 1, 'current fire still works after recovery');
});

test('banked movement is capped, reset on spawn and cannot manufacture simulation time', () => {
    const room = new Room('BUDGET'); room.botCount = 0; const actor = room.add('Budget', 'hunter', 'blue'); room.start(0);
    for (let tick = 1; tick <= 1000; tick++) room.tick(tick * STEP * 1000);
    assert.equal(actor.credit, MAX_PENDING_INPUTS);
    room.spawn(actor, 17000); assert.equal(actor.credit, 1, 'lobby/death time is not movement credit in a new life');
    for (let batch = 0; batch < 50; batch++) room.enqueue(actor, Array.from({ length: MAX_INPUT_BATCH }, (_, n) => ({ ...neutralInput(batch * MAX_INPUT_BATCH + n + 1), forward: 1 })), 17000);
    for (let tick = 1; tick <= 60; tick++) {
        room.tick(17000 + tick * STEP * 1000);
        assert.ok(actor.state.ack <= tick + 1, 'only one newly elapsed step can be spent per server tick');
        assert.ok(actor.queue.length <= MAX_PENDING_INPUTS);
    }
});
