# Hitscan timing verification — 2026-09-06

Exact base revision: `1d6e3badaf75f6cf6722ec9b79f78e4f44408fe1`.

This is a locally verified candidate, not a deployed fix. GET requests to the public deployment's `/api/health` and `/api/rooms` timed out after 15 seconds, so its current revision and room configuration could not be verified. The sandbox cannot launch a browser; none was launched and no CDP connection was attempted.

## Diagnosis

The supplied hypothesis was correct, with an additional limit: the base revision sets `MAX_REWIND_MS` to **250 ms**, not 1000 ms. `MAX_QUEUED_SHOT_AGE_MS` was 1000 ms. An adaptive 100–500 ms reserve, downlink latency, upstream travel and input batching make the rendered opponent much older than that 250 ms ceiling. The client already sent its playback cursor as `shotTime`, but the server moved that timestamp forward before checking the target.

The baseline was measured before changing production code. The same harness was subsequently copied into a clean `git archive` of the exact base and rerun, including strict FIFO delivery and confirmation counts on both clients. The expected-hit assertion fails on that base. Full per-shot records are in [before.json](before.json) and [after.json](after.json): rendered time/position, sent timestamp, sampled and received delay, server RTT, actual rewind time/position, positional discrepancy, ray origin discrepancy, and hit outcome.

Expanding the rewind budget alone removed the large timestamp error but still missed one shot in the initial 350 ms run ([intermediate measurements](rewind-only.json)). With identical timestamps, the target differed by 45 cm. The client interpolated the two surrounding 20 Hz snapshots while the server interpolated intermediate 60 Hz simulation poses. Batched movement advances several commands in one tick and then waits for another packet; those intervening stepped poses are not what the client draws. The server now records combat history on the same timestamped snapshot timeline. Sliding height is interpolated too. Bots aim at the current simulation and use current target poses.

## Final hit measurements

Each row contains 24 shots against a moving opponent. Both impaired profiles include the documented recurring downlink jitter; these are not constant-delay tests. The 350 ms regression fails on the archived base and passes on the candidate.

| Added RTT profile | Before hits | After hits | Measured RTT p50, before / after | Rewind timestamp error p50, before / after | Target error p50, before / after |
|---|---:|---:|---:|---:|---:|
| 0 ms | 24/24 (100.00%) | 24/24 (100.00%) | 8 / 9 ms | 0.00 / 0 ms | 0.00931 / 0.00222 m |
| 100 ms + jitter | 1/24 (4.17%) | 24/24 (100.00%) | 106 / 106 ms | 404.30 / 0 ms | 3.37978 / 0.00174 m |
| 350 ms + jitter | 1/24 (4.17%) | 24/24 (100.00%) | 355 / 355 ms | 585.79 / 0 ms | 4.74209 / 0.00176 m |

After the fix, **every shot** used exactly the requested timestamp. Maximum target discrepancy was **0.00468 m**, within remote snapshot centimetre quantization. All 72 hits reached both clients, no resyncs occurred, every logged ray origin discrepancy was zero, and applied local correction and snapshot camera jumps were **0 m** in every profile. Before and after files include every shot, including misses, not selected examples.

## Regression verification

- `npm test`: **190/190 pass**, including all 184 existing tests, protocol compatibility, malformed timing rejection, bounded rewinds, old-life inputs, walls, friendly fire, spawn protection, cooldown and ammo checks. A real four-second WebSocket upload stall verifies the targeted expiry notice, unchanged server ammo, movement acknowledgement and acceptance of fresh fire after recovery.
- `npm run build`: passes, including TypeScript checking and the production client/server bundles.
- `npm run test:integration`: passes with two real clients, all primary weapons, damage/kills, reload, respawn, historical hitscan and reconnect.
- `npm run audit:map`: **77 objects, 0 geometry/collider mismatches**. Existing collision and map prediction tests pass.
- All twelve deterministic two-minute bad-link movement sessions at 60/144 Hz pass: raw and applied correction, clipped snapshot jumps, backward correction and deviation from the unimpaired trajectory are **0 m**; no inputs are dropped and no stalled movement frames freeze. [Movement report](movement.json), [input response report](input-response.json).
- The separate **120-second real WebSocket** movement session passed, with measured RTT p50/p95/p99/max **356/1601/2981/4232 ms**. Raw correction, visible correction, snapshot jumps, backward corrections and trajectory deviation were **0 m**. All **870** moving frames during the four-second blackout advanced; sequence gaps and dropped inputs were **0**. [WebSocket report](movement-websocket.json). Frame timings are the driver's capped simulation delta, not GPU/display measurements.

The first untouched-baseline load attempt passed the two- and five-human cases, then failed at ten humans: 58.46 Hz, 19.536 ms worst-window tick p95 and a 483.328 ms peak tick. The original failure is retained in [load-before-0-initial.json](load-before-0-initial.json). The isolated ten-human retry passed at 60.03 Hz and 3.501 ms p95 ([retry](load-before-0.json)); no thresholds were relaxed. The baseline's 80 ms each-way matrix also passed all three counts ([report](load-before-80.json)). This pause occurred before the candidate was loaded, so it is not evidence of a regression caused by this patch.


All six candidate load cases passed the existing assertions. Each case measures 30 seconds after warm-up, with seven server bots, against a bundled production server on Node 25.9.0. Baseline and candidate runs were sequential; the successful initial baseline two/five-human results and the isolated ten-human retry are shown for 0 ms. The candidate load clients send the new timing field, so its bandwidth/decoding cost is included. These are workstation results, not Railway measurements.

| Delay each way | Humans | Tick Hz before / after | Mean tick ms before / after | Worst-window tick p95 ms before / after | Worst client snapshot p99 after |
|---|---:|---:|---:|---:|---:|
| 0 ms | 2 | 60.00 / 60.03 | 1.047 / 0.789 | 3.471 / 1.667 | 52 ms |
| 0 ms | 5 | 59.99 / 60.01 | 1.490 / 0.995 | 3.927 / 2.651 | 53 ms |
| 0 ms | 10 | 60.03 / 60.00 | 1.289 / 1.397 | 3.501 / 4.293 | 53 ms |
| 80 ms | 2 | 60.01 / 59.99 | 0.723 / 0.726 | 1.708 / 1.483 | 52 ms |
| 80 ms | 5 | 59.97 / 59.99 | 1.024 / 1.092 | 2.406 / 2.926 | 53 ms |
| 80 ms | 10 | 59.98 / 60.02 | 1.432 / 1.478 | 3.868 / 4.799 | 53 ms |

Candidate prediction p99 is **0 m** in every row; there are **0 replica errors and 0 desyncs**. Tick processing remains within the original 16.67 ms p95 budget. Full candidate reports: [0 ms](load-after-0.json), [80 ms each way](load-after-80.json).

Reproduce the production load and movement checks against an isolated `npm start` server:

```sh
GAME_URL=http://127.0.0.1:8080 LOAD_REPORT=/tmp/load-0.json npm run test:load
GAME_URL=http://127.0.0.1:8080 LOAD_LATENCY_MS=80 LOAD_REPORT=/tmp/load-80.json npm run test:load
GAME_URL=http://127.0.0.1:8080 BAD_LINK_REPORT=/tmp/movement.json npm run test:bad-link:ws
```

## Scope and policy

- New inputs include the actual age of the playback cursor at sampling, not merely the desired interpolation reserve. A previewed shot keeps its original aim, timestamp and delay when committed on the next physics step. Queuing never refreshes these timestamps.
- The server validates finite delays in **0–1000 ms**. Rewind allows that delay plus half the independently measured RTT and 150 ms for input pacing, ticks and clock error. **Total rewind cannot exceed 1500 ms**, regardless of a client's claim. Future timestamps cannot select a future target. Life, health, protection, team, collision, weapon cooldown and ammo remain authoritative.
- `MAX_QUEUED_SHOT_AGE_MS` remains **1000 ms**, now measured from firing (`shotTime + bounded interpolationDelay`), instead of treating the older rendered-world time as the firing time. Target history older than 1500 ms also expires.
- A shot delayed for four seconds intentionally **does not cause retroactive damage or consume server ammo**. Its movement is processed and acknowledged as before. The sender receives a targeted `shot-rejected` control message and sees “Shot expired during connection delay. Fire again.” Notifications are limited to one per second; expired inputs do not delay fresh fire. This protects opponents from deaths several seconds after they took cover while making the loss explicit to the stalled player.
- The wire subprotocol is `arena-v3`. The optional delay adds four bytes per input, at most **446 bytes per 12-command packet**, within the existing 4096-byte payload cap. The new server still handles cached `arena-v2` binary and older JSON clients; absent timing metadata retains the conservative 250 ms ceiling. Deploy both client and server and reload old tabs to receive the fix.
- Local prediction, collision, movement credit, retained input count and interpolation smoothing are unchanged. Historical player positions are never accepted from clients.

## What the headless session exercises

`tests/hitscan-websocket.ts` runs the real HTTP/WebSocket server with two production `Network` clients. Both clients join the same FFA room with the same team, ready up, and start normally. Only initial placement and the target's health pool are fixtures; movement, aiming and firing use real input packets. The moving target traverses a clear lane using shared prediction. The stationary shooter aims at the torso centre returned by `remotePlayers()`, never at server state. Every proposed crosshair ray is checked for a visible body intersection and clear static line of sight. Production spread, recoil, cadence, ammo, hitboxes and protection remain enabled. The server instrumentation only observes `fire` and the history lookup; it does not alter hit results.

Each profile warms up for 12 seconds, then fires 24 shots 700 ms apart. Latency labels are **added round-trip latency**, split equally between upload and download. The 100 and 350 ms profiles add a 350 ms downlink stall every three seconds, growing the actual adaptive reserve. Each direction uses a FIFO and drains in order, including coalesced packets. Native WebSocket pongs are delayed so the server measures the impaired RTT itself. Scheduling adds a few milliseconds, recorded in each report. This synthetic jitter is not claimed to be a replay of the unavailable human session trace.

Every server hit must also arrive as a hit event at both real clients. Assertions require 24/24 hits, zero resyncs, zero applied local correction and zero snapshot camera jump. Run all profiles, or isolate the reported link:

```sh
HIT_REPORT=artifacts/hitscan/after.json npm run test:hitscan:ws
HIT_RTTS=350 npm run test:hitscan:ws
```

For the baseline, archive the revision above into a temporary directory, link its `node_modules` to an installed dependency tree, copy **only** `tests/hitscan-websocket.ts` into it, and run `npx tsx tests/hitscan-websocket.ts` there. The test saves every profile before making its expected-hit assertions; the baseline exits nonzero. No compatibility switch disables the assertion.

## Simpler causes checked

- FFA accepts opponents on the same team; TDM deliberately blocks teammates. The two-client FFA test uses two blue players. Existing server tests cover hostile teams, friendly fire and static occlusion.
- Protection ends 1500 ms after spawn; firing clears the shooter's own protection. The measured shots begin well after expiry. Delayed inputs from an earlier life still cannot fire after respawn.
- The model torso centre is at 1.03 m within the 0.65–1.35 m body zone; its head centre is at 1.57 m within the 1.35–1.88 m head zone. Rendering and hitboxes use the same 0.68 sliding scale. The hitboxes intentionally approximate the central silhouette, not every animated arm, hat brim or held weapon.
- Base camera and hitscan directions share positive pitch/up and the same yaw convention; existing Three.js camera tests verify projection and ray direction. Local shot feedback and server hitscan share `eyeHeight` and `shotRays`. The session logs identical camera/authority origins. Cosmetic camera bob, slide eye easing, fractional movement previews and damage shake can offset a moving/damaged camera from the fixed simulation eye; they were not involved in this stationary-shooter reproduction and are unchanged.

## Limits

These results establish real Node client/server hit registration under the documented latency and jitter, not a human browser/GPU playtest or a deployed Railway result. During a prolonged stall, extrapolated/blended remote poses may not correspond to real history; delayed confirmation cannot become instantaneous. Inputs outside the explicit combat windows expire even though longer movement history is retained. The larger historical window permits hits on an opponent's past pose for up to 1.5 seconds, an intentional bounded fairness tradeoff.

The workspace's `.git` is read-only. The complete patch is `/tmp/krunker-hitscan-1d6e3ba.patch`, against `1d6e3badaf75f6cf6722ec9b79f78e4f44408fe1`. It includes source, tests and measurement reports. Apply it to a clean checkout of that revision, then commit/deploy both client and server and reload old tabs. Do not apply it over this already modified workspace. All test servers created for this task were closed by their test runners.
