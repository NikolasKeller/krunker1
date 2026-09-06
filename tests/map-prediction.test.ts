import assert from 'node:assert/strict';
import test from 'node:test';
import { BOXES } from '../src/shared/map';
import { moveState, neutralInput, RADIUS } from '../src/shared/movement';
import { STEP, type Input, type PlayerState } from '../src/shared/types';
import { CLASS_IDS } from '../src/shared/weapons';
import { decodeClientMessage, encodeClientMessage, wireInput } from '../src/shared/protocol';
import { predictInput, reconcile } from '../src/client/prediction';
import { Room } from './sandyard-room';

const fields = [...Object.keys(moveState()), 'yaw', 'pitch'] as (keyof PlayerState)[];
function movement(p: PlayerState) { return Object.fromEntries(fields.map(k => [k, p[k]])); }

test('recorded walking inputs produce identical client, server and replay positions at every building face', () => {
    let positions = 0;
    for (const b of BOXES.filter(b => b.kind === 'building')) for (const axis of ['x', 'z'] as const)
        for (const side of [-1, 1]) for (const classId of CLASS_IDS) {
            const room = new Room('MAP-PARITY'); room.botCount = 0;
            const actor = room.add('Walker', classId, 'blue'); room.start(0);
            const start = moveState(b.x, b.y - b.h / 2, b.z);
            const half = (axis === 'x' ? b.w : b.d) / 2;
            start[axis] += side * (half + RADIUS + 2);
            Object.assign(actor.state, start);
            const initial = { ...actor.state }, predicted = { ...initial };
            const yaw = axis === 'x' ? side * Math.PI / 2 : side < 0 ? Math.PI : 0;
            // Capture a deterministic control/packet tape once, then feed the
            // actual client predictor and server queue separately. Slot and ADS
            // changes exercise both speed-scale call sites; no jump or slide.
            const recording = Array.from({ length: 120 }, (_, n) => {
                const input = wireInput({ ...neutralInput(n + 1), life: initial.life, forward: 1, yaw,
                    slot: (Math.floor(n / 40) + 1) as Input['slot'], aim: n % 30 >= 20 });
                return { input, packet: encodeClientMessage({ type: 'input', inputs: [input] }) };
            });
            for (const { input, packet } of recording) {
                predictInput(predicted, input, true);
                const message = decodeClientMessage(packet);
                assert.equal(message.type, 'input');
                if (message.type !== 'input') throw new Error('invalid recording');
                const now = input.seq * STEP * 1000;
                assert.ok(room.enqueue(actor, message.inputs, now));
                room.tick(now);
                assert.equal(actor.state.ack, input.seq);
                assert.deepEqual(movement(predicted), movement(actor.state), `${classId} building (${b.x},${b.z}) ${axis}/${side} seq ${input.seq}`);
                assert.ok(side * (predicted[axis] - b[axis]) >= half + RADIUS - 1e-9, `walking enters building: ${JSON.stringify({ b, axis, side, input, predicted })}`);
                positions++;
            }
            const replayed = reconcile(initial, recording.map(r => r.input), true).predicted;
            assert.deepEqual(movement(replayed), movement(actor.state), 'pending-input replay follows identical collision');
            assert.ok(Math.abs(side * (predicted[axis] - b[axis]) - half - RADIUS) < 1e-6, 'recording actually reaches the wall');
        }
    console.log(`Walking prediction: ${positions} identical positions across all building faces and classes`);
});
