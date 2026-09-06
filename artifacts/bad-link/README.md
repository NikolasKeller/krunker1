# Bad-link movement recovery — 2026-09-06

Base revision: `4663eb798daa4b5b3d86f69e81e795b5aa2d2c59`.

The candidate is implemented and tested locally. **It has not been deployed, and the required candidate load measurement inside Railway remains blocked by CLI authentication.** The current live deployment cannot be considered fixed until both client and server changes are deployed together. No LAN/intermediate-build observations were used.

## What was wrong

The earlier decoupling let the client continue simulating but still threw away its movement on recovery:

1. The sender retained only 12 unsent steps and allowed only 30 unacknowledged steps. A 350 ms RTT already consumes about 21 steps of that allowance. Stalls regularly overflowed it, replacing unsent commands with newer ones.
2. The server banked only 12 ticks, processed at most three per tick, and discarded everything except the latest 12 queued steps after a receive burst. Acknowledgements could consequently skip commands the client had already applied and retained for prediction. There was no replay of those missing steps on the server.
3. After 250 ms of upload silence the server applied neutral movement without advancing the acknowledgement. Friction, gravity, grounding and jump timers then changed the replay origin behind the client's back.
4. The old camera continuity check measured `predicted + correction`. The renderer actually uses `correctedPosition()`, which clips that offset against geometry. Metre-scale disagreements could therefore become immediate visible jumps despite the algebraically continuous offset. We now measure the production clipping function and the complete rendered trajectory against an unimpaired client.
5. Local firing cadence used the estimated server clock. An asymmetric/delayed pong could move that clock backwards and prolong a local firing cooldown. Firing feedback now uses the monotonic render clock.

## Changes

- Keep ordered unsent movement for 600 steps, allow 360 in flight, and retain 600 prediction steps independently. Packets remain at most 12 commands/398 bytes, sent at 20 Hz. Recovery sends the oldest retained commands first and uses partial acknowledgement credit; it cannot deadlock waiting for an entire backlog to fit.
- Bank at most 600 elapsed server ticks and process at most 12 commands per actor per tick. Every retained command is simulated in order. Credit resets on spawn and sequence gaps never create simulation time. Queue and payload bounds remain enforced.
- Human movement changes only when a command is acknowledged. During an upload stall, other players see the last authoritative pose until command processing catches up. The local player continues immediately.
- Suppress same-contact cosmetic disagreements up to 8 cm entirely, retaining local position, velocity and movement timers. Health, ammunition, life and meaningful contact changes still come from authority. Remaining corrections drift at at most 0.6 m/s with a 400 ms exponential time constant, rather than the former 6 m/s/56 ms recovery.
- Same-life snapshots cannot replace local yaw/pitch. The camera already used the controls' mouse angles directly; spawn orientation remains a life transition. `LocalMotion`, now shared by the game and regression tests, samples every rendered frame, commits fixed 60 Hz prediction steps, and previews between them. Full transport windows do not gate either operation.
- Retained movement does not authorize arbitrarily old combat. Shots more than one second old expire; current shots retain the existing server cooldown, ammunition, collision and rewind checks. Local muzzle flash, recoil, tracers and sound remain immediate.

`window.__arena.metrics.movement` exposes raw, applied and collision-clipped snapshot correction p50/p95/max, corrections over 1 cm per second, maximum per-frame smoothing distance, dropped-input count and sample count. Percentiles retain up to 24,000 snapshot samples; maxima and the frequency counter span the connection. Benchmark reports explicitly measure the two-minute movement interval, with ten additional seconds used only to verify eventual server convergence.

## Measurements

All distances below are metres. Each deterministic session lasts **120 seconds**, at both 60 and 144 rendered frames/s, and includes turning, changing aim, jumping and sliding in a clear map lane. Tests compare every rendered frame with an unimpaired client applying the same controls; they also require that the server eventually reaches that complete travelled path. They do not merely assert a small smoothing offset.

The supplied probe provides quantiles, not a timestamped trace, so two documented synthetic profiles are used:

- **Matched quantiles:** ordered TCP delivery with probe RTT p50 **350 ms**, p95 **1121 ms**, p99 **1908 ms**, max **2158 ms**. It exercises the normal latency and recurring stalls, without claiming to reproduce the unknown original trace.
- **Four-second blackout stress:** the same base latency, frequent one-second stalls, larger tails and an explicit four-second upload/download outage. Delivered probe RTT is **350 / 1600 / 2925 / 4175 ms** for p50/p95/p99/max. The tail is deliberately heavier than the supplied connection's overall percentiles. A four-second ordered-stream blackout holds multiple consecutive probes; it is not represented as one independently delayed packet.

The identical harness was run against an archived clean copy of the base revision and against the candidate. Representative 144 Hz results:

| Profile / transport | Before correction p50 / p95 / max | Before corrections >1 cm/s | After p50 / p95 / max | After >1 cm/s |
|---|---:|---:|---:|---:|
| Matched quantiles / hidden TCP queue | 0 / 0.09549 / 16.15667 | 1.550 | 0 / 0 / 0 | 0 |
| Four-second stress / hidden TCP queue | 0 / 0.06466 / 24.28323 | 1.508 | 0 / 0 / 0 | 0 |
| Four-second stress / blocked socket | 0 / 0.00717 / 21.03454 | 0.917 | 0 / 0 / 0 | 0 |
| Four-second stress / upload only | 0 / 0.06466 / 28.61327 | 1.517 | 0 / 0 / 0 | 0 |

Across all 12 candidate sessions: maximum reconciliation **0 m**, maximum collision-clipped snapshot jump **0 m**, maximum backward correction **0 m**, dropped inputs **0**, and frozen movement frames during the explicit outage **0**. The worst original backward rendered frame was **28.52751 m**. The original stress runs discarded 1,406–1,531 client commands. Complete data: [before](before.json), [after](after.json).

A separate **real Node WebSocket** session against the built production server ran for two minutes, plus recovery. Its measured probe RTT was **356 / 1600 / 2971 / 4224 ms**. Correction p50/p95/max, snapshot jumps, backward corrections and deviation from the unimpaired client were all **0 m**. All **888** moving frames within the four-second blackout advanced; there were no sequence gaps or dropped commands. [WebSocket report](websocket-local.json). `simulationFrameMs` records the driver's capped simulation delta, not GPU/display frame timing.

The production render-input driver was tested at 100 different physics-step phases at each of 60, 144 and 240 Hz, with both transport windows full. Every press produced visible movement in the **first rendered frame**: at most **16.67 / 6.94 / 4.17 ms**, respectively. The same frame received fire input and local camera angles. [Input response report](input-response.json). Existing tests exercise immediate shot visuals/sound for every weapon; a new test checks firing cadence through server-clock offset changes of ±4 seconds.

## Load and validation

`npm test`: **184/184 pass**. `npm run build` (including typecheck) passes. No Chromium launch or CDP connection was attempted.

Fresh local production-server matrices, 30 seconds per row, seven bots, Node 25.9.0:

| Added latency each way | Humans | Tick Hz | Mean tick ms | Worst window tick p95 ms | Worst client snapshot p99 ms | Desyncs / replica errors |
|---|---:|---:|---:|---:|---:|---:|
| 0 ms | 2 | 60.00 | 0.723 | 1.851 | 52 | 0 / 0 |
| 0 ms | 5 | 59.98 | 0.969 | 2.382 | 52 | 0 / 0 |
| 0 ms | 10 | 60.00 | 1.391 | 3.749 | 52 | 0 / 0 |
| 80 ms | 2 | 60.01 | 0.660 | 1.450 | 54 | 0 / 0 |
| 80 ms | 5 | 60.01 | 1.017 | 2.483 | 53 | 0 / 0 |
| 80 ms | 10 | 59.99 | 1.520 | 3.893 | 52 | 0 / 0 |

Prediction p99 was 0 m in every row. All original matrix assertions pass. [0 ms results](load-local-0.json), [80 ms results](load-local-80.json). These are workstation results, not a substitute for Railway's Node 22 measurements.

Both `railway status` and `railway ssh` failed with `failed to refresh OAuth token: Operation not permitted (os error 1)` followed by `Unauthorized`. Saving refreshed credentials requires writing outside the sandbox. There is consequently **no claim that the candidate's Railway load criterion has passed**.

After applying, committing and deploying the patch, an authenticated calling agent can run:

```sh
python3 tests/railway-bad-link.py --expect-revision <full-deployed-candidate-SHA>
# Allow about six minutes for both matrices and the two-minute WebSocket session.
python3 tests/railway-bad-link.py --collect
```

The launcher verifies the live revision and requires an unoccupied server. It runs the same tests from inside the deployed container against the public deployment URL, without deploying or changing existing game rooms. Reports are collected into this directory. The launcher was syntax/help checked locally; SSH execution could not be verified here.

Local reproduction:

```sh
BAD_LINK_REPORT=artifacts/bad-link/after.json INPUT_RESPONSE_REPORT=artifacts/bad-link/input-response.json npm run test:bad-link
npm run build
PORT=8088 npm start
# Separate terminal, with no other players on this test server:
GAME_URL=http://127.0.0.1:8088 BAD_LINK_REPORT=artifacts/bad-link/websocket-local.json npm run test:bad-link:ws
```

## Limits that remain

These results establish controllable local movement in the production simulation/render-input path under the specified stalls. They are not an actual browser/GPU or human playtest; the sandbox cannot launch a browser. Physical input-to-display latency and unrelated rendering performance still need confirmation on the player's machine.

Remote players still freeze or catch up, and they see the stalled player's authoritative pose freeze and then catch up. Damage, hit confirmation, death, respawn, ammunition and reload outcomes still arrive late. The server's rewind is capped at 250 ms, so it cannot validate a four-second-old view of a moving target; expired shots intentionally do not fire after recovery. The character can die at its last known server position during an outage. Life transitions and real gameplay disagreements still reconcile. Outages beyond the bounded retention window are outside this guarantee and can lose movement. No client change can deliver absent information or make these combat outcomes instantaneous.

## Patch handoff

The workspace's `.git` is read-only. The complete patch (source, tests and reports) is written to `/tmp/krunker-bad-link-4663eb7.patch`, against the exact base revision above. Apply it to a clean checkout of that revision; do not apply it again over this already modified workspace. Commit/push/deployment and authenticated Railway verification remain for the calling agent.

Cleanup note: the sandbox also denied signals to the test server processes. Check and stop the Node test listeners on ports 8088, 8089 and 8090 outside the sandbox after collecting anything needed; the benchmark clients have disconnected.
