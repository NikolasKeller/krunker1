# Playtest fixes — 2026-09-06

Original base: `1f23d755f90df79ff9507c6cd65aa974533e4913`. This session did not deploy changes. An external process committed the implementation as `e61002281f932f33d2299176050cdf871143fd45` while verification was still running; that commit captured an unfinished 80 ms report. Use the completed reports accompanying this document. A later read-only request to public `/api/health` confirmed that the external deployment also serves `e61002281f932f33d2299176050cdf871143fd45`.

## Collision

No recording identifies the exact wall from the player report. Investigation confirmed several independently reproducible failures:

- Endpoint resolution chose the exit side of sufficiently thin geometry. At the actual 28 m/s cap, a 15 cm collider centered at x=32 took a player from x=31.544 to x=32.455 in one 60 Hz tick. Correct contact is x=31.545. Existing primary map walls are thicker; this reproduction proves the algorithm flaw without claiming that ordinary walking tunneled through one of those walls.
- The visible lamp at (-32,18) had no collider: a maximum-speed step crossed its center. Roof caps, rooftop units and lamp solids now come from shared `DETAIL_BOXES`, rendered at exactly the dimensions used by movement and hitscan. Door artwork remains on closed building colliders. Decorative paint/trim retains the existing low-poly style.
- The recent correction smoothing added unconstrained offsets to the camera. Even two legal positions on opposite sides of a building could produce a camera path through it. Fractional previews and the final corrected camera now sweep the expanded player volume against boxes and ramp planes. Geometry takes priority over preserving a smooth correction at a wall.
- Ramp sides only tested the player's center. Their collision/support footprint now includes player radius. Reduced floor-contact width and broad vertical contact tolerances were also removed.

Movement integrates forces and input edges once, then subdivides collision displacement to at most 10 cm per axis, including vertical motion. The bound is smaller than the player radius, so even a zero-thickness wall cannot be crossed between tests. Entry-side resolution prevents pushing through thin solids. Swept vertical crossing checks preserve ceilings and landings; step-ups check head clearance.

Server simulation, idle movement, client prediction and replay all call the same shared `move()`. The server accepts validated controls and spends simulation credits; it does not accept client positions. No transport queue, credit, rate, wire format or rewind limit changed.

Regression coverage includes 6,120 cases spanning every one of the 51 solid boxes, both sides of both axes, five approach angles, air/slide/hop motion, and 60 Hz / 50 ms steps. Stacked boosts reach the actual 28 m/s cap. Additional tests cover assembled wall joints, doors, boundary corners, all ramp side orientations, the underpass, fast vertical collisions, camera correction and exact authoritative/predicted/replayed movement. An additional deterministic randomized probe completed 222,000 maximum-speed movement steps without solid-box overlap.

## Shot feedback

Previously only sound, recoil and muzzle flash ran locally. Every tracer and impact waited for a server event. `ShotFeedback.fire()` now creates tracers from the projected weapon muzzle in the same render frame, along the current aim/spread rays. Muzzle flash, recoil, shell ejection and static impact decals also appear immediately. Input aim is quantized like the wire command, and a shot between physics ticks retains its pre-recoil aim for the next command.

Client and server use shared range, pellet, spread and recoil calculations and an input-sequence/life seed instead of unknowable server fire time. Local visual prediction does not test or apply player damage. Authoritative shot events correct existing impact decals without replaying local tracers or sound; hit events continue to create hitmarkers, damage numbers and blood immediately on confirmation. Existing server fire cadence, reloads, hit validation, rewind and damage remain authoritative.

Tests cover all six weapons, same-frame visual creation before any server shot, muzzle origin, matching server ray endpoints, silent correction and duplicate suppression. The live binary-socket hitmarker/damage-number regression also passes.

## Remote representation

The reserve begins at 100 ms and grows from a 120-arrival delivery-jitter window (95th percentile transit variation and sudden arrival gaps), up to 500 ms. Half RTT adds the baseline one-way age, capped at 500 ms. Growth uses a 15 ms threshold; shrinkage requires five calm seconds, a 25 ms margin and a maximum 10 ms/second reduction. Playback speeds up/slows down within 0.75–1.1x instead of jumping backwards when delay or clock offset changes.

Late snapshots extrapolate the last velocity for at most 250 ms, clipped against world solids. New snapshots blend out the discrepancy; lives and removals reset tracks. A longer outage deliberately reaches the cap and stops. In the deterministic 350 ms baseline RTT fixture with dropped snapshots and >1 s tail RTT bursts, all frames with interpolation/extrapolation runway advance; only the first unlearned tail gap reaches the cap (five frames). The test bounds displacement, health changes, correction, and disconnected drift.

The mesh and UI receive the exact same sample once per animation frame, including interpolated health. Nameplates were also incorrectly behind the HUD's 90 ms throttle; they now update before it and retain their DOM nodes. A DOM regression checks position, health and node identity on consecutive 10 ms frames.

Rendering delay is separate from the unchanged 250 ms authoritative rewind cap. Severe latency can still put displayed targets outside that history; this work cannot replace missing network data. Shot timestamps use the actual remote playback time.

## Viewmodel and previews

Removed left-arm geometry and reload transforms for every weapon; the right arm is retained. Tests cover hip, aim and reload poses. `npm run preview:geometry && npm run preview:hud` generates the software map background and 24 HUD/viewmodel review pages, with the real viewmodel rendered by the calling agent's browser.

Start at `artifacts/hud-preview/index.html`. Individual pages are `{sniper,rifle,shotgun,smg,pistol,knife}-{hip,aim,reload}.html`, plus the existing six HUD states. Sniper aim freezes before the full scope hides the weapon. These generated HTML files remain ignored by Git; regenerate after applying the patch. No browser launch or CDP connection was attempted. External screenshot review remains outstanding.

## Verification and load

`npm test`: 122/122 pass. `npm run build` and `npm run test:integration` pass. Load runner assertions are unchanged. Production server bundle SHA-256: `0d981d44824c2a7e8b257088a37012d966541a38a77ae8c1b52968fb0178e6e7`.

All local matrices use the built server at `http://127.0.0.1:8088`, Node 25.9.0, 2/5/10 humans, seven bots and 30 seconds per stage. Added latency is one-way in both directions. These are local measurements, not Railway-origin measurements.

The 0 ms matrix passes with zero desyncs, zero replica errors and zero prediction p99 error. Snapshot p99 is 52/52/53 ms for 2/5/10 humans. See [0 ms report](load-local-0.json).

The first 80 ms run failed the unchanged tick-processing budget at ten humans: maximum sampled-window tick p95 32.82 ms, mean tick 1.772 ms, snapshot p99 74 ms, zero desyncs/replica errors and zero prediction p99 error. Build/tests were running concurrently; contention is a possible explanation, not an established cause. The full failure is retained in [the initial 80 ms report](load-local-80-contended.json). A complete repeat after those verification processes finished passed, without code or threshold changes: [final 80 ms report](load-local-80.json).

| Added one-way latency | Humans | Snapshot p99 (worst client) | Max sampled-window tick p95 | Desyncs / replica errors | Prediction p99 |
|---|---:|---:|---:|---:|---:|
| 0 ms | 2 | 52 ms | 1.556 ms | 0 / 0 | 0 m |
| 0 ms | 5 | 52 ms | 2.518 ms | 0 / 0 | 0 m |
| 0 ms | 10 | 53 ms | 4.765 ms | 0 / 0 | 0 m |
| 80 ms | 2 | 52 ms | 1.486 ms | 0 / 0 | 0 m |
| 80 ms | 5 | 52 ms | 2.369 ms | 0 / 0 | 0 m |
| 80 ms | 10 | 54 ms | 4.768 ms | 0 / 0 | 0 m |

The required Railway-origin remeasurement is blocked. `railway status` returned `failed to refresh OAuth token: Operation not permitted (os error 1)` and `Unauthorized`; this sandbox cannot write the saved CLI login. After authentication and deployment outside the sandbox, run:

```sh
python3 tests/railway-load.py --expect-revision FULL_DEPLOYED_COMMIT_SHA
# Approximately four minutes later:
python3 tests/railway-load.py --collect
```

This bundles the unchanged load harness with the new shared prediction code, launches it from inside Railway against the public HTTPS/WSS address, requires the exact deployed revision and an empty service, and saves both matrices locally on collection. The launcher does not deploy changes. It has been prepared but could not be executed with the expired login.

## Patch handoff

The workspace's `.git` is read-only to this session. The complete binary patch against the original base is `/tmp/furo-playtest-fixes/playtest-fixes.patch`; the smaller `/tmp/furo-playtest-fixes/verification-after-e610022.patch` contains only the final reports and Railway runner missing from the external implementation commit. Do not apply the complete patch over changes already present in a checkout. The generated preview pages are available in this shared workspace and can also be regenerated from their committed generators.
