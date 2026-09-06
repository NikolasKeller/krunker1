import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { writeFileSync } from 'node:fs';
import { Network } from '../src/client/network';
import { runBadLinkSession, SessionSocket } from './bad-link-session';

const reports: unknown[] = [];
after(() => { if (process.env.BAD_LINK_REPORT) writeFileSync(process.env.BAD_LINK_REPORT, JSON.stringify(reports, null, 2) + '\n'); });
for (const calibrated of [false, true]) for (const mode of ['hidden', 'blocked', 'upload-only'] as const) for (const hz of [60, 144]) {
    test(`two minutes of ${calibrated ? 'measured-quantile' : 'four-second blackout'} movement at ${hz} Hz (${mode})`, t => {
        t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
        for (const [key, value] of Object.entries({ WebSocket: SessionSocket, location: { protocol: 'http:', host: 'test' }, sessionStorage: { getItem: () => null, setItem() {} } })) {
            const previous = Object.getOwnPropertyDescriptor(globalThis, key);
            Object.defineProperty(globalThis, key, { configurable: true, value });
            t.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else Reflect.deleteProperty(globalThis, key); });
        }
        const net = new Network(); t.after(() => net.disconnect());
        net.connect({ name: 'Walker', room: '', classId: 'hunter', team: 'blue' });
        const report = runBadLinkSession(net, net.ws as unknown as SessionSocket, hz, mode, calibrated);
        reports.push(report);
        if (calibrated) {
            assert.equal(report.probeRttMs.p50, 350); assert.equal(report.probeRttMs.p95, 1121); assert.equal(report.probeRttMs.p99, 1908);
        } else assert.ok(report.probeRttMs.max >= 4000, 'stress includes the full four-second outage');
        assert.equal(report.dropped, 0, 'movement during stalls must reach authority');
        assert.equal(report.sequenceGaps, 0, 'the server must receive every applied local input in order');
        assert.equal(report.frozenStallFrames, 0, 'local motion continues through the four-second outage');
        assert.ok(report.rawCorrectionMetres.max < .001, JSON.stringify(report));
        assert.ok(report.snapshotCameraJumpMetres.max < 1e-8, JSON.stringify(report));
        assert.ok(report.maxBackwardFrameMetres < .001, JSON.stringify(report));
        assert.ok(report.deviationFromUnimpairedClientMetres.max < .001, JSON.stringify(report));
        assert.ok(report.finalReferenceErrorMetres < .001, 'authority eventually follows the complete locally travelled path');
    });
}
