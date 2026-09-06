import { RemoteInterpolation, MAX_EXTRAPOLATION_MS, type RemoteFrame } from '../src/client/interpolation';
import { Room } from './sandyard-room';
import { moveState } from '../src/shared/movement';
import type { PlayerState } from '../src/shared/types';
import { distribution, separation, uploadDelay } from './bad-link-session';

export type RemoteProfile = 'stable' | 'matched-quantiles' | 'one-second-stalls' | 'four-second-blackout';
export function runRemoteSession(profile: RemoteProfile, hz = 60, dropped = false) {
    const duration = 120000, step = 1000 / hz;
    const interpolation = new RemoteInterpolation(), frames: RemoteFrame[] = [];
    const player = { ...new Room('REMOTE-MEASURE').add('Runner', 'triggerman', 'red').state, ...moveState(34, 0, 0), protectionEnd: 0 };
    const pose = (time: number): PlayerState => ({ ...player, z: 12 * Math.sin(time * .00045), vz: 5.4 * Math.cos(time * .00045), yaw: time * .0003 });
    const latency = (time: number) => profile === 'stable' ? 175 : uploadDelay(time, profile === 'four-second-blackout', profile === 'matched-quantiles');
    const deliveries: { time: number; arrival: number }[] = [];
    let lastArrival = 0;
    for (let time = 0; time < duration; time += 50) {
        if (dropped && time > 0 && (time % 850 === 0 || time % 2150 === 0)) continue;
        lastArrival = Math.max(lastArrival, time + latency(time));
        deliveries.push({ time, arrival: lastArrival });
    }
    const probes: { arrival: number; rtt: number }[] = [];
    let up = 0, down = 0;
    for (let time = 0; time < duration; time += 250) {
        up = Math.max(up, time + latency(time));
        down = Math.max(down, up + (profile === 'four-second-blackout' && up >= 55000 && up < 59000 ? Math.max(175, 59000 - up) : 175));
        probes.push({ arrival: down, rtt: down - time });
    }
    const rtts = probes.map(p => p.rtt), gaps: number[] = [], steps: number[] = [], recoverySteps: number[] = [], ages: number[] = [], error: number[] = [];
    let lastApplied: number | undefined, previous: PlayerState | undefined, underruns = 0, exhausted = 0, underrunFrames = 0, exhaustedFrames = 0;
    let wasUnder = false, wasExhausted = false, ping = 350, freezeFrames = 0, applied = 0;
    const underrunStarts: number[] = [];
    for (let frame = 0; frame * step < duration; frame++) {
        const now = frame * step;
        while (probes[0]?.arrival <= now) ping = probes.shift()!.rtt;
        let updated = false;
        while (deliveries[0]?.arrival <= now) {
            const d = deliveries.shift()!;
            if (lastApplied !== undefined) gaps.push(d.arrival - lastApplied);
            lastApplied = d.arrival; applied++; updated = true;
            interpolation.observe(d.time, d.arrival);
            frames.push({ time: d.time, players: new Map([[player.id, pose(d.time)]]) });
            if (frames.length > 64) frames.shift();
        }
        const state = interpolation.sample(frames, '', now, now, ping)[0];
        if (!state) continue;
        const time = interpolation.playbackTime!;
        const late = Math.max(0, time - frames.at(-1)!.time);
        const under = late > .001, out = late > MAX_EXTRAPOLATION_MS + .001;
        if (under) { underrunFrames++; if (!wasUnder) { underruns++; underrunStarts.push(now); } }
        if (out) { exhaustedFrames++; if (!wasExhausted) exhausted++; }
        if (previous) {
            const distance = separation(state, previous);
            steps.push(distance);
            if (updated && wasUnder) recoverySteps.push(distance);
            if (distance < 1e-6 && Math.abs(pose(time).vz) > .1 && now > 500) freezeFrames++;
        }
        ages.push(now - time); error.push(separation(state, pose(time)));
        previous = state; wasUnder = under; wasExhausted = out;
    }
    return { profile, synthetic: true, seconds: duration / 1000, renderHz: hz, dropped, appliedStates: applied,
        probeRttMs: distribution(rtts), appliedStateGapMs: distribution(gaps), renderStepMetres: distribution(steps),
        recoveryStepMetres: distribution(recoverySteps), playbackAgeMs: distribution(ages), errorFromHistoricalPoseMetres: distribution(error),
        interpolationUnderruns: underruns, interpolationUnderrunFrames: underrunFrames, underrunStartsMs: underrunStarts,
        underrunsAfter30Seconds: underrunStarts.filter(t => t >= 30000).length,
        exhaustedRunwayEpisodes: exhausted, exhaustedRunwayFrames: exhaustedFrames, freezeFrames };
}
