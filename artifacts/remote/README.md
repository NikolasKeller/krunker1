# Remote motion and predicted health

Exact base: `c52f2d1a4ca7e4530e59e298a94f4c83680547cc`.

The transport investigation was read before changing gameplay. Its decision was to retain WebSocket; it changed no production source and did not resolve the reported stalls. Its live captures showed burst delivery and gaps as large as 2043 ms despite a roughly 50 ms server cadence. This change keeps that transport.

The existing client already applied authoritative health and deaths outside position playback. What was missing was a presentation ledger for provisional damage. Position still had only 250 ms of extrapolation, a 500 ms jitter reserve, and an unbounded collision-clipped recovery step.

## Behavior

- Extrapolate along the last velocity for up to **1250 ms / 32 m**, stopping at geometry. The distance ceiling covers a one-second stall even near maximum running speed. Recovery uses a 180 ms exponential blend with at most **3 m/s of offset correction**; the final displacement is bounded too. Collision sweeps begin at the previous visible position. A long render pause cannot complete a correction in one frame. Respawn is a new life/first appearance, not a correction of a still-visible life.
- Learn from growing delivery silence before the missing packet arrives. Grow immediately; renew the hold when a large gap recurs; wait 30 seconds before shrinking at 20 ms/second. The reserve ranges from 100 to 2100 ms. The larger limit is needed for the two-second tails in this profile. Stable 350 ms RTT still renders 275 ms behind; an established severe link can render about 2275 ms behind.
- The cursor advances monotonically, at 0.25–1.1 times real time while adapting. Health is not interpolated. Animation velocity is derived from the same final position sample used by the mesh and nameplate. The game passes that one sample to aiming, rendering and HUD in each frame.
- Preserve the actual speed between snapshot positions during ordinary playback. Batched input processing can advance more movement than its endpoint velocity suggests. Artificially limiting this ordinary segment created a render/rewind mismatch; a dedicated regression now covers it.
- Allow up to 2500 ms of declared playback delay and retain 3000 ms of server history, including upload/tick allowance. The one-second expiration of **queued** fire is unchanged; a four-second-old shot still expires. Both client and server changes must ship together.
- Synchronize the estimated server clock only from samples within 25 ms of the minimum RTT in the recent, bounded 60-second window. Delayed pongs still update the displayed ping, but cannot masquerade as a clock change and understate the shot's rewind budget. Arrival/animation timing uses the monotonic clock.
- Provisional hits synchronously subtract their damage from the shared rendered health sample. Pending damage is keyed by shooter life/sequence and victim, with separate victim-life tracks. Confirmations atomically replace the authoritative baseline and retire just their prediction; snapshot ACKs also retire already included shots. Other pending shots remain subtracted. Misses, rejections and amount disagreements ease toward authority with a 120 ms time constant. New damage during that ease remains immediate. Removal, respawn, expiry and reconnect clear the appropriate predictions. Only authoritative `alive` controls death, and predicted hits never change real health, kills or score.

## Measurement method and acceptance limits

`tests/remote-session.ts` drives the production interpolation at 60 and 144 Hz for 120 seconds per case, using identical before/after inputs. It uses ordered delivery and the same synthetic profiles as the preceding transport/movement investigations. The target moves along an unobstructed lane, reversing smoothly, with maximum speed 5.4 m/s. Additional cases omit approximately 8% of independent full states, including consecutive omissions. This represents gaps between successfully reconstructed snapshots, not applying deltas with missing baselines. Production delta validation remains unchanged.

The accepted maximum displacement in this fixture is **0.15 m per 60 Hz frame**, scaled by frame duration at 144 Hz. Ordinary movement is at most 0.09 m/frame; the remaining 0.06 m allows up to 0.05 m of correction and the 10% playback speed adjustment. This is less than one fifth of the 0.76 m player diameter. Faster legitimate running has a speed-dependent envelope; a fixed 15 cm limit would incorrectly slow a 28 m/s slide. Separate regressions cover stationary multi-metre corrections, collision sweeps, render pauses, new lives and disconnected actors.

“Interpolation underrun” means the playback cursor has passed the newest state. “Exhausted runway” means it also exceeds the extrapolation time ceiling. Both are reported: extrapolation is not relabeled as successful interpolation. The initial unseen stalls require short extrapolation while the adaptive buffer learns. A four-second outage deliberately exceeds the cap and may stop a player temporarily, followed by bounded recovery.

The gap distributions count every applied state, including zero-gap states in a recovered burst. Consequently p95 can look healthy despite a large maximum. Reports retain p50/p95/p99/max, underrun start times, exhausted-runway counts, frozen frames and actual render displacement. These are Node replay/DOM/WebSocket measurements, not browser screenshots, GPU frame rate, or a kernel-level network impairment experiment. No browser or CDP connection was attempted.

## Measured results

All p50/p95/max figures below include startup and adaptation. Each row is a 120-second 60 Hz replay without omitted states; paired 144 Hz and omitted-state cases are in the linked JSON.

| Profile | RTT p50 / p95 / max (ms) | Applied gaps, before = after (ms) | Render step before (m) | Render step after (m) |
| --- | --- | --- | --- | --- |
| stable | 350 / 350 / 350 | 50 / 50 / 50 | 0.064 / 0.090 / 0.090 | 0.064 / 0.090 / 0.090 |
| matched-quantiles | 350 / 1121 / 2158 | 50 / 50 / 1858 | 0.061 / 0.090 / 1.078 | 0.062 / 0.090 / 0.091 |
| one-second-stalls | 350 / 1350 / 2350 | 50 / 50 / 2050 | 0.059 / 0.090 / 1.264 | 0.062 / 0.090 / 0.090 |
| four-second-blackout | 350 / 1600 / 4175 | 50 / 50 / 3875 | 0.058 / 0.090 / 2.584 | 0.062 / 0.090 / 0.133 |

| Profile | Interpolation underruns before → after | Underruns after 30 s before → after | Exhausted runway before → after | Frozen frames before → after |
| --- | --- | --- | --- | --- |
| matched-quantiles | 20 → 2 | 15 → 0 | 20 → 0 | 331 → 0 |
| one-second-stalls | 20 → 2 | 15 → 0 | 20 → 0 | 589 → 0 |
| four-second-blackout | 20 → 3 | 15 → 1 | 20 → 1 | 758 → 30 |

On the principal one-second-stall profile, recovery-frame displacement p50/p95/max falls from **0.249 / 1.162 / 1.264 m** to **0.002 / 0.002 / 0.005 m**. The two remaining interpolation underruns occur only while learning the initial one- and two-second stalls; none exhaust extrapolation. The explicit four-second outage stops motion at the cap for 30 frames, then recovers with at most 5 cm on the recovery frame. Packet arrivals are unchanged; this fixes presentation, not the underlying transport delay.

[Before](before.json), [after](after.json). All 16 replay cases satisfy the frame-scaled 15 cm bound. The corresponding eight dropped-state regression cases run in the unit suite.

**243/243 unit tests pass**, including all existing tests, with the old health-interpolation expectations updated to immediate health and the network test updated for a monotonic clock and bounded recovery after a render pause. Typecheck, production build and real HTTP/WebSocket integration pass. All twelve two-minute local-movement regressions retain **0 m correction**, **0 m visible snapshot jump**, and **zero dropped inputs**. [Verification](verification.json), [movement](local-movement.json).

The final one-second-stall real-WebSocket session measures RTT **357 / 1179 / 2181 ms**, fires **240/240 aimed hits**, and records zero prediction disagreements, rejected shots, resyncs or local movement correction. The 30-second calibration period includes the first occurrence of the profile’s two-second tail; motion replay above includes that calibration in its counts. Rewind timestamps match exactly; target error is at most 0.01045 m. Provisional feedback computation is 0.573 / 0.901 / 4.574 ms and the bar is checked against the firing-frame sample. Five brief interpolation-underrun episodes are recorded across this real session, with **zero exhausted-runway episodes**. [Full session](combat-one-second.json).

The final repeat of the preceding 350 ms combat profile also passes: **240/240 hits**, zero disagreements, zero rewind timestamp error, zero local correction, and at most 0.00490 m pose quantization error. Maximum provisional computation is 4.372 ms; all six weapon/HUD updates finish within 6 ms. Across the two final live sessions, **480/480 aimed shots hit**. [350 ms regression session](combat-350.json).

Both original load matrices pass **inside Railway on Node v22.23.2**, against the isolated candidate listener, with 30 seconds per row and seven bots. The live game had four background players; candidate processes used reduced CPU priority, and the original candidate-server isolation check passed. There are zero desyncs, replica errors and dropped inputs in every row; movement prediction p99 is zero. The tested server and load-client bundle hashes match the final working source. This is a Railway runtime/loopback result, not a public-edge or deployed-client acceptance result.

| Added each-way delay | Humans + bots | Tick Hz | Mean tick ms | Highest window tick p95 ms | Worst client snapshot p99 ms | Desyncs |
| --- | --- | --- | --- | --- | --- | --- |
| 0 ms | 2 + 7 | 60.00 | 0.427 | 1.171 | 52 | 0 |
| 0 ms | 5 + 7 | 60.00 | 0.520 | 1.487 | 52 | 0 |
| 0 ms | 10 + 7 | 60.00 | 0.883 | 3.265 | 52 | 0 |
| 80 ms | 2 + 7 | 60.03 | 0.428 | 1.226 | 52 | 0 |
| 80 ms | 5 + 7 | 59.98 | 0.524 | 1.603 | 52 | 0 |
| 80 ms | 10 + 7 | 60.01 | 0.851 | 2.823 | 52 | 0 |

[Railway status and provenance](railway-status.json), [Railway 0 ms](railway-load-0.json), [Railway 80 ms](railway-load-80.json). The same two matrices also pass locally: [0 ms](load-0.json), [80 ms](load-80.json).

`window.__arena.metrics.remote` exposes bounded sample windows for applied gaps, render steps and recovery steps, plus lifetime maxima and underrun/exhaustion counts. The production deployment remains unchanged; the candidate must be shipped before the player can see these changes.

## Regression findings retained

The first live 350 ms run recorded 239/240 hits. Limiting ordinary playback by endpoint velocity produced a 0.5004 m render/rewind mismatch; preserving snapshot-segment speed fixed it. [Original failure](combat-350-first-failure.json).

The next run had 240/240 hits, zero disagreements and at most 0.00484 m snapshot quantization error, but failed its unchanged timing checks while other local verification ran: the maximum weapon update was 23 ms and the provisional timer included an extra instrumentation HUD pass. The timer now ends immediately after production feedback, with DOM verification outside it; final timing runs are isolated. [Contended result](combat-350-contended.json).

The first one-second-stall run had 235/240 hits. A burst of delayed pongs moved the estimated clock about 300 ms, understating playback delay; the server clamped requested history by up to 197.26 ms. Filtering clock samples fixed the cause instead of relaxing hit assertions or server timing tolerances. [Clock failure](combat-one-second-clock-failure.json).

## Reproduce

```sh
REMOTE_REPORT=artifacts/remote/after.json npx tsx tests/remote-report.ts
BAD_LINK_REPORT=artifacts/remote/local-movement.json npm test
npm run build
npm run test:integration
HIT_RTTS=350 HIT_SAMPLES=240 HIT_INTERVAL_MS=140 COMBAT_REPORT=artifacts/remote/combat-350.json npm run test:combat:ws
HIT_RTTS=350 HIT_SAMPLES=240 HIT_INTERVAL_MS=140 HIT_LINK_PROFILE=one-second-stalls HIT_WARMUP_MS=30000 COMBAT_REPORT=artifacts/remote/combat-one-second.json npm run test:combat:ws
python3 tests/railway-remote.py
python3 tests/railway-remote.py --collect
```

Baseline: archive the exact base revision into a separate directory, link/install dependencies, copy only `tests/remote-session.ts` and `tests/remote-report.ts` into it, and run the same report command with a separate destination. The baseline gameplay source is unchanged.

The Railway runner uploads the candidate server and unchanged load client as bundles into `/tmp`, uses Railway's installed `ws`, runs a separate candidate HTTP/WS listener with reduced CPU priority, and closes it after both matrices. It does not alter `/app`, join live rooms, disconnect existing players, or deploy. The original load-runner isolation checks and all its assertions are retained. Live-service occupancy is recorded as background host load. Results verify the candidate inside Railway over loopback; they do not measure its public-edge route or deploy it to players.

The live revision observed during this work was the base above. To verify the eventual public deployment from inside Railway, the existing `tests/railway-combat.py --expect-revision <full-candidate-SHA>` runner is available; its public-server isolation guard requires no other players on that endpoint.

## Patch

The workspace `.git` is read-only. The complete source, test and measurement patch is `/tmp/krunker-remote-c52f2d1.patch`, against exact base `c52f2d1a4ca7e4530e59e298a94f4c83680547cc`. Apply to a clean checkout of that revision; these working files already contain the changes. No commit, push or production deployment is included.
