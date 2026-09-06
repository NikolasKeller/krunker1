import { arrivalReport, distribution, type Arrival } from './metrics';

export type Cause = 'loss-recovery' | 'shared-queue';
export type Profile = 'matched-quantiles' | 'blackout-stress';
// A sensitivity model, NOT a TCP implementation, measured retransmission
// trace, netem run, or evidence about the affected player.
export function model(profile: Profile, cause: Cause) {
    const duration = 120000;
    const delay = (time: number) => {
        let latency = 175;
        const phase = time % 6000, tail = time % 30000;
        const regularEnd = profile === 'matched-quantiles' ? 2771 : 3000;
        const tailEnd = profile === 'matched-quantiles' ? 15808 : 16000;
        if (phase >= 2000 && phase < regularEnd) latency += regularEnd - phase;
        if (tail >= 14000 && tail < tailEnd) latency = Math.max(latency, 175 + tailEnd - tail);
        if (profile === 'blackout-stress' && time >= 55000 && time < 59000) latency = Math.max(latency, 59000 - time);
        return latency;
    };
    let lastTcp = 0, wasStalled = false;
    const tcp: Arrival[] = [], udp: Arrival[] = [];
    for (let sent = 0, n = 1; sent < duration; sent += 50, n++) {
        const latency = delay(sent), stalled = latency > 175;
        lastTcp = Math.max(lastTcp, sent + latency);
        tcp.push({ n, sent, arrived: lastTcp, bytes: 1024, applied: true });
        // Both causes generate exactly the SAME TCP observations. One assumes
        // only the packet starting a stall was lost; the other delays ALL
        // datagrams in that interval. The latter may also be bufferbloat.
        // A real four-second blackout drops UDP throughout, in both cases.
        const blackout = profile === 'blackout-stress' && sent >= 55000 && sent < 59000;
        if (!blackout && !(cause === 'loss-recovery' && stalled && !wasStalled)) {
            udp.push({ n, sent, arrived: cause === 'shared-queue' ? lastTcp : sent + 175, bytes: 1024, applied: true });
        }
        wasStalled = stalled;
    }
    udp.sort((a, b) => a.arrived - b.arrived || a.n - b.n);
    let appliedSeq = 0;
    for (const r of udp) { r.applied = r.n > appliedSeq; if (r.applied) appliedSeq = r.n; }
    const probes = [];
    let probeUp = 0, probeDown = 0;
    for (let sent = 0; sent < duration; sent += 250) {
        probeUp = Math.max(probeUp, sent + delay(sent));
        const returnDelay = profile === 'blackout-stress' && probeUp >= 55000 && probeUp < 59000 ? Math.max(175, 59000 - probeUp) : 175;
        probeDown = Math.max(probeDown, probeUp + returnDelay);
        probes.push(probeDown - sent);
    }
    return { profile, cause, synthetic: true, durationSeconds: duration / 1000,
        tcpRttMs: distribution(probes), tcp: arrivalReport(tcp, 0, duration + 175),
        unreliable: arrivalReport(udp, 0, duration + 175), tcpTrace: tcp, unreliableTrace: udp };
}
