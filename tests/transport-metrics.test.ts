import test from 'node:test';
import assert from 'node:assert/strict';
import { arrivalReport, IndependentReplica } from './transport/metrics';
import { model } from './transport/model';
import type { ServerMessage } from '../src/shared/types';

test('independent states tolerate missing, reordered and duplicated packets without rollback', () => {
    const replica = new IndependentReplica();
    const state = (n: number): Extract<ServerMessage, { type: 'snapshot' }> => ({
        type: 'snapshot', n, base: 0, full: true, time: n * 50,
        players: [{ id: 'a', x: n, y: 0, z: 0, hp: 100 }], removed: [],
    });
    assert.equal(replica.apply(state(1)), true);
    assert.equal(replica.apply(state(3)), true);
    assert.equal(replica.apply(state(2)), false);
    assert.equal(replica.apply(state(3)), false);
    assert.equal(replica.players.get('a')?.x, 3);
    assert.throws(() => replica.apply({ ...state(4), full: false }));
    assert.throws(() => replica.apply({ ...state(4), players: [{ id: 'a', x: NaN }] }));
    assert.equal(replica.n, 3, 'invalid packets do not consume the sequence');
    assert.equal(replica.apply({ ...state(4), players: [] }), true);
    assert.equal(replica.players.size, 0, 'missing actors in a full snapshot are removed');
});

test('identical TCP traces permit both a large UDP gain and no gain', () => {
    const loss = model('matched-quantiles', 'loss-recovery'), queue = model('matched-quantiles', 'shared-queue');
    assert.deepEqual(loss.tcpTrace, queue.tcpTrace);
    assert.deepEqual(loss.tcpRttMs, queue.tcpRttMs);
    assert.ok(loss.unreliable.appliedGapMs.max! < loss.tcp.appliedGapMs.max! / 10);
    assert.deepEqual(queue.unreliable.appliedGapMs, queue.tcp.appliedGapMs);
});
test('an outage still stalls the unreliable channel', () => {
    const loss = model('blackout-stress', 'loss-recovery');
    assert.ok(loss.unreliable.appliedGapMs.max! >= 4000);
});
test('arrival metrics count only applied states and retain a trailing total outage', () => {
    const report = arrivalReport([
        { n: 1, sent: 0, arrived: 100, bytes: 10, applied: true },
        { n: 3, sent: 100, arrived: 200, bytes: 10, applied: true },
        { n: 2, sent: 50, arrived: 201, bytes: 10, applied: false },
    ], 0, 5000);
    assert.equal(report.appliedGapMs.max, 100);
    assert.equal(report.maxSilenceIncludingEdgesMs, 4800);
    assert.equal(report.rejected, 1);
    assert.equal(arrivalReport([], 0, 5000).maxSilenceIncludingEdgesMs, 5000);
});
