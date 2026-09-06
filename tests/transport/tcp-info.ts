import { spawn } from 'node:child_process';
import type { WebSocket } from 'ws';
import { distribution, type Arrival } from './metrics';

type TcpSample = {
    at: number; txRetransmitPackets: number; txRetransmitBytes: number | null;
    rxOutOfOrderBytes: number | null; rttMs: number; rtoMs: number;
    sendBufferBytes: number | null; lossRecovery: boolean | null;
};
export function sampleTcp(ws: WebSocket) {
    const samples: TcpSample[] = [], errors: string[] = [];
    const helper = process.env.PROBE_TCP_INFO_HELPER;
    // ws/Node expose no public TCP_INFO API. Keep this optional diagnostic
    // dependency on the private fd outside all production code.
    const fd = (ws as unknown as { _socket?: { _handle?: { fd?: number } } })._socket?._handle?.fd;
    const child = helper && Number.isInteger(fd) && fd! >= 0 ? spawn(helper, [], { stdio: ['pipe', 'pipe', 'pipe', fd!] }) : undefined;
    let partial = '';
    child?.on('error', e => errors.push(e.message));
    child?.on('exit', code => { if (code) errors.push(`TCP helper exited ${code}`); });
    child?.stdout?.on('data', chunk => {
        partial += chunk.toString();
        const lines = partial.split('\n'); partial = lines.pop()!;
        for (const line of lines) {
            try { samples.push({ ...JSON.parse(line), at: performance.now() }); }
            catch (e) { errors.push(String(e)); }
        }
    });
    child?.stderr?.on('data', chunk => errors.push(chunk.toString()));
    return {
        stop: () => child?.stdin?.end(),
        report: (rows: Arrival[], started: number, ended: number) => {
            const window = samples.filter(s => s.at >= started && s.at <= ended);
            const first = window[0], last = window.at(-1);
            const delta = (key: 'txRetransmitPackets' | 'txRetransmitBytes' | 'rxOutOfOrderBytes') =>
                first?.[key] != null && last?.[key] != null ? last[key]! - first[key]! : null;
            const applied = rows.filter(r => r.applied);
            const gaps = applied.slice(1).map((r, i) => ({ start: applied[i].arrived, end: r.arrived })).filter(g => g.end - g.start > 100);
            // Association only, +/- one sampling interval. A retransmitted
            // upload is not proof of a retransmitted download, and no OOO
            // bytes does not rule out loss of an entire flight or an edge stall.
            const near = (key: 'txRetransmitPackets' | 'rxOutOfOrderBytes') => !first || first[key] == null ? null :
                gaps.filter(g => window.some((s, i) => i > 0 && s.at >= g.start - 50 && s.at <= g.end + 50 && s[key]! > window[i - 1][key]!)).length;
            const interior = (key: 'txRetransmitPackets' | 'rxOutOfOrderBytes') => !first || first[key] == null ? null :
                gaps.filter(g => window.some((s, i) => i > 0 && window[i - 1].at >= g.start && s.at <= g.end && s[key]! > window[i - 1][key]!)).length;
            return {
                available: window.length > 1, errors,
                status: child ? 'optional per-socket OS counters' : helper ? 'socket fd unavailable' : 'helper not configured',
                sampleIntervalMs: 50, txRetransmitPackets: delta('txRetransmitPackets'), txRetransmitBytes: delta('txRetransmitBytes'), rxOutOfOrderBytes: delta('rxOutOfOrderBytes'),
                tcpRttMs: distribution(window.map(s => s.rttMs)),
                gapsOver100Ms: gaps.length, gapsNearTxRetransmission: near('txRetransmitPackets'), gapsNearRxOutOfOrderActivity: near('rxOutOfOrderBytes'),
                gapsWithInteriorTxRetransmission: interior('txRetransmitPackets'), gapsWithInteriorRxOutOfOrderActivity: interior('rxOutOfOrderBytes'),
                samples: window.map(s => ({ ...s, at: s.at - started })),
            };
        },
    };
}
