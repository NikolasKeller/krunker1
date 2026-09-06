**Combat feedback verification — 2026-09-06**

Exact base revision: `f3e926f98d6ba0117fa0bb325ab7bc1f05e403e2`.

The candidate fixes immediate combat confirmations, provisional hits, and local weapon presentation. It is verified locally and has not been deployed. The required load matrix inside Railway remains unverified because CLI authentication fails. All clients in these measurements are Node WebSocket clients; no browser launch or CDP connection was attempted.

The extra death delay was primarily client playback. The server queued shot/hit/kill events until the 20 Hz snapshot boundary. Separately, `RemoteInterpolation` delayed `alive` and health along with position, including the adaptive jitter reserve. The renderer itself simply sets character visibility from `alive`; there is no delayed death animation. The killfeed, death card and weapon/ammunition HUD also sat behind a 90 ms refresh gate.

At 350 ms added RTT, the baseline lethal shot took **843 ms from input to the opponent disappearing**. Its kill arrived 195 ms after resolution, but the opponent stayed visible for **456 ms after that confirmation**. The feed appeared another 85 ms after confirmation. The candidate lethal shot took **356 ms from input to disappearance**, with both disappearance and feed update within 1 ms of receiving authority. Provisional hit feedback is already visible before that response.

The following rows use added round-trip latency, split equally between upload and download. The 100 and 350 ms profiles also include a 350 ms downlink stall every three seconds. Each direction is FIFO, including coalesced deliveries; native pongs are delayed so the server measures the impaired RTT. These are synthetic profiles, not a replay of the unavailable player trace. Each profile warms up for 12 seconds and fires 24 aimed shots at a moving opponent.

| Added RTT | Resolution → receipt before, p50 / p95 / max | After, p50 / p95 / max | Resolution → raw socket before, p50 / p95 / max | After, p50 / p95 / max |
|---|---:|---:|---:|---:|
| 0 ms | 6 / 36 / 39 ms | 2 / 6 / 6 ms | 1 / 33 / 35 ms | 0 / 1 / 1 ms |
| 100 ms | 83 / 205 / 386 ms | 52 / 223 / 402 ms | 17 / 34 / 36 ms | 0 / 1 / 1 ms |
| 350 ms | 198 / 296 / 510 ms | 178 / 315 / 529 ms | 17 / 35 / 36 ms | 0 / 1 / 1 ms |

Resolution is timestamped at the return from the real server `Room.fire`; receipt is measured when the impaired production `Network` receives the message. Both use the same host clock, avoiding cross-host clock estimation error. Raw socket receipt is recorded before the artificial download FIFO, isolating application batching and local WebSocket delivery. All per-shot timestamps are retained in [before.json](before.json) and [after.json](after.json). The production combat envelope also includes its server resolution timestamp. The browser’s `combatReceiptMs` diagnostic uses estimated server time, so it is less exact under asymmetric latency.

The server batching wait is gone: raw delivery is at most 1 ms in all three candidate profiles. Downlink stalls still delay authoritative confirmations; their tails cannot be removed by an immediate send. Different shot phases relative to the periodic synthetic stall account for the remaining p95/max variation.

| Added RTT | Key → visible weapon/HUD before, median / max | After, median / max | Provisional hit computation, median / max |
|---|---:|---:|---:|
| 0 ms | 126 / 131 ms | 3 / 5 ms | 0.431 / 3.426 ms |
| 100 ms | 227 / 399 ms | 5 / 6 ms | 0.366 / 1.045 ms |
| 350 ms | 456 / 505 ms | 3 / 5 ms | 0.392 / 0.731 ms |

The baseline had no provisional hit feedback. All 72 candidate profile shots produced it synchronously in the firing frame and hit on the server. Keyboard measurements dispatch real `Digit1`, `Digit2` and `Digit3` DOM events through `Controls`, then run the production weapon selection, Three.js viewmodel and HUD. The harness verifies drawable weapon geometry inside the viewmodel camera and waits for the matching weapon label/ammo presentation. It runs a 4 ms Node render driver, not a browser display. Separate tests exercise first-frame weapon presentation at 100 input phases at each of 60, 144 and 240 Hz for every latency label. The crosshair and scope use the selected weapon before the HUD throttle. GPU scanout and physical speaker latency are not measured.

The sustained 350 ms session fired **240 aimed rifle shots**, at 140 ms requested spacing with normal ammo, reloads, spread, recoil and recovery. **240/240 hit**, **0/240 disagreed (0.0000%)**, none were rejected or left unconfirmed, and the hit sound callback ran exactly 240 times. Measured RTT was 356 / 617 / 623 ms; provisional computation was 0.400 ms median, 4.070 ms maximum. Target rewind timestamp error was zero; maximum pose discrepancy was 0.004701 m (snapshot quantization). Movement correction, snapshot camera jumps and resyncs were zero. [Full session](session-350.json).

The initial rapid-fire fixture lowered target health when creating the final input. An earlier in-flight shot killed it, producing one correctly detected false positive: **1/240 (0.4167%)**. The [original report](session-350-fixture-race.json) is retained; its death timing is invalid because a later miss overwrote the fixture’s death timestamp. The corrected harness changes health at the designated final resolution and latches the actual death once. No game rules were changed to suppress this race. Real concurrent damage can still cause this sort of rare disagreement, which retracts the provisional number and marker quietly.

Implementation and reconciliation:

- `Room.fire` broadcasts one compact combat envelope immediately after resolving the shot. It carries shot identity, accepted/missed/rejected result, hit/damage/kill events and authoritative health/death/score fields. A death includes its freeze pose. These packets use the reliable WebSocket even when a snapshot would be skipped for backpressure; a connection with more than 1 MiB queued is closed for reconnect rather than silently losing combat messages. Already queued TCP data cannot be overtaken.
- The client applies authoritative combat fields immediately. Living position interpolation still uses the established snapshot timeline. Known death, health and respawn-life changes bypass that buffer. Respawn remains the deliberate 2200 ms server timer, processed at 60 Hz and announced in a snapshot; there is no extra death animation timer.
- Client and server share ray generation, pellet aggregation, nearest-player selection, static occlusion, sliding hitboxes and falloff. Prediction uses the exact command that will be committed, including life, sequence, aim, timing and movement. The original command remains pinned across a render-frame preview so recoil cannot alter it before transmission. Provisional callbacks never mutate opponents, kills or score, and never play a lethal sound.
- Confirmation matches shooter/life/sequence exactly. It keeps the existing hitmarker, damage node and sound; overkill damage updates the existing number. A rejection or miss fades the provisional number in 80 ms without touching a newer marker. Session counters include false positives, false negatives, zone/damage disagreements, rejected and unresolved shots. `window.__arena.metrics.combat` exposes them and the game logs the counters every 30 seconds.
- Slot presentation changes locally in the first render frame: viewmodel, short draw animation, crosshair/scope, ammo and slot highlight. Per-weapon ammo estimates survive switches and old snapshots. Immediate authoritative weapon acknowledgements cannot overwrite a newer selection; corrections update quietly. The server retains firing permission.
- A shared command clock gives both sides the same 180 ms draw gate (rounded to the next 60 Hz command), recoil/aim/recovery and firing cadence. The previous client gate was 100 ms while the server gate was 180 ms. Server command counts, not sequence gaps or arrival bursts, enforce timing; existing simulation credit still bounds catch-up. Reload presentation blocks local firing until authority completes it or a switch cancels it.
- The new wire subprotocol is `arena-v4`; new input packets add one byte per command (458 bytes maximum for twelve commands). The server still accepts older v2/v3 binary and JSON clients and sends their legacy combat events immediately. Client and server must be deployed together, and existing tabs reloaded for prediction and the death-buffer fix.

Validation: **205/205 unit tests pass**, including the existing 190 and 15 combat regressions. Typecheck/build pass. The map audit reports **77 objects, zero collider/geometry mismatches**. All twelve deterministic two-minute bad-link movement cases retain zero correction and dropped inputs; [movement report](movement.json), [input response report](input-response.json). The real production integration suite passes: all primary weapons, damage, headshots, killfeed/score, respawn/protection, historical hitscan, malformed input, round lifecycle and reconnect.

The bundled production server passed both 30-second-per-row load matrices, with seven bots and Node 25.9.0. Load clients use the new explicit combat inputs and weapon predictor. Every row has zero desyncs, zero replica errors, zero prediction error at p99, and no dropped inputs. The original assertions were not relaxed.

| Each-way delay | Humans | Tick Hz | Mean tick ms | Worst-window tick p95 ms | Worst client snapshot p99 ms |
|---|---:|---:|---:|---:|---:|
| 0 ms | 2 | 60.03 | 0.723 | 1.643 | 53 |
| 0 ms | 5 | 60.00 | 0.981 | 2.578 | 53 |
| 0 ms | 10 | 59.99 | 1.382 | 4.476 | 53 |
| 80 ms | 2 | 60.02 | 0.662 | 2.266 | 53 |
| 80 ms | 5 | 59.98 | 0.945 | 2.855 | 53 |
| 80 ms | 10 | 59.99 | 1.107 | 3.826 | 53 |

[Zero-delay load](load-0.json), [80 ms each-way load](load-80.json). Peak client bandwidth was 16.94 KB/s, below the existing 50 KB/s limit. One 38 ms tick occurred in the two-human zero-delay row; its worst-window p95 was 1.643 ms and all unchanged acceptance assertions passed.

The separate **120-second real WebSocket movement session** passed, including a four-second outage. RTT p50/p95/p99/max was **356 / 1514 / 2980 / 4229 ms**. Raw and visible correction, camera jumps, backward corrections, deviation from the unimpaired trajectory and eventual server error were all **0 m**. All **799** moving frames during the outage advanced; sequence gaps and dropped inputs were zero. [WebSocket movement report](movement-websocket.json). Frame timing in that report is the driver’s capped simulation delta, not GPU timing.

Railway verification is blocked. `railway status` and `railway ssh` report `failed to refresh OAuth token: Operation not permitted (os error 1)` followed by `Unauthorized`. Both existing stored token forms were also rejected. [SSH output](railway-access.txt). Local results are not a substitute for the required in-Railway matrix; no deployment or Railway load pass is claimed.

Reproduce the measured combat sessions:

```sh
COMBAT_REPORT=artifacts/combat-feedback/after.json npm run test:combat:ws
HIT_RTTS=350 HIT_SAMPLES=240 HIT_INTERVAL_MS=140 COMBAT_REPORT=artifacts/combat-feedback/session-350.json npm run test:combat:ws
```

For the baseline, archive the exact base SHA to a temporary directory, link/install its dependencies, copy only `tests/combat-latency.ts` into it, and run `node_modules/.bin/tsx tests/combat-latency.ts` with `COMBAT_REPORT` set. The harness feature-detects the absent predictor; its baseline gameplay remains unchanged.

For local production regression, start an isolated built server, then run:

```sh
GAME_URL=http://127.0.0.1:8080 npm run test:integration
GAME_URL=http://127.0.0.1:8080 LOAD_REPORT=/tmp/load-0.json npm run test:load
GAME_URL=http://127.0.0.1:8080 LOAD_LATENCY_MS=80 LOAD_REPORT=/tmp/load-80.json npm run test:load
GAME_URL=http://127.0.0.1:8080 BAD_LINK_REPORT=/tmp/movement.json npm run test:bad-link:ws
```

After the patch is committed and both client/server are deployed, an authenticated caller can run the original 2/5/10-human, seven-bot load matrices and two-minute movement session inside Railway:

```sh
python3 tests/railway-combat.py --expect-revision <full-deployed-candidate-SHA>
python3 tests/railway-combat.py --collect
```

The launcher checks the deployed revision and requires an unoccupied service. It does not deploy. The workspace `.git` is read-only; the complete patch is `/tmp/krunker-combat-f3e926f.patch`, against the exact base above. Apply it to a clean checkout, not over this already modified workspace. Test servers are closed by their runners.
