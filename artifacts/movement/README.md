# Movement stall investigation — 2026-09-06

Base revision: `dce73382f71c655a1098bd03eaf47f617cae6559`. The changes and measurements in this directory have **not been deployed**.

## Cause and change

`Network.input()` rebuilt local prediction from the last authoritative state whenever `InputBuffer` discarded an unsent command. Backpressure therefore stopped movement after the 12-step unsent window filled (200 ms), or after the 30 in-flight plus 12 unsent steps filled (about 700 ms). The existing test explicitly asserted this broken behavior. Good snapshot/correction statistics could conceal the freeze because local movement had already been erased before the next snapshot arrived.

Prediction now advances on every 60 Hz simulation step, with independent, bounded six-second replay history. Rendering previews the fractional next step, so movement responds between physics steps on 144 Hz displays as well. Evicting old history cannot rewind movement when upload-only outages continue delivering old acknowledgements. Health/death/life changes still apply. The incorrect freeze assertion now verifies continued movement and history bounds.

Reconciliation preserves the displayed camera position for every same-life correction, including offsets above the previous 3 m teleport cutoff. Small corrections decay at the existing rate; large offsets settle at at most 6 m/s (10 cm per frame at 60 FPS, 4.17 cm at 144 FPS). Respawns still reset the camera immediately. This is visual smoothing: authority and collision simulation still correct immediately.

The sender remains 20 Hz, with 12 unsent and 30 in-flight inputs. It retains the newest controls, including recent stop/turn/jump edges, while replacing old unsent controls. No wire-format or server changes were made. The load client now uses the same independent prediction history as the game.

Remote interpolation formerly used a fixed 100 ms server-time delay. With 80 ms one-way delivery and 50 ms snapshot spacing this leaves only 20 ms of reserve. It now reserves 100 ms **plus half RTT**, capped by the 250 ms server rewind limit; shot timestamps use the same delay. The test verifies continuous interpolation between arrivals. Remote actors still hold the latest known pose during a multi-second outage; there is no unbounded extrapolation through geometry.

## Reproduction against the deployed game

Node WebSocket probes connected to `https://krunker1-production.up.railway.app`, running the original and updated `Network` implementations against the unchanged deployed server. They held ordered WebSocket uploads and downloads for one or two seconds, then released them. No browser or CDP was used.

| Stall | Original frozen physics steps | Fixed frozen steps | Original distance | Fixed distance |
|---|---:|---:|---:|---:|
| 1 s | 18 / 60 | 0 / 60 | 6.89 m | 10.13 m |
| 2 s | 80 / 120 | 0 / 120 | 6.53 m | 20.93 m |

Original recovery correction peaked at 46.59 m/s. Fixed correction never exceeded 6 m/s. Snapshot camera jumps were below `2e-15` m (floating-point noise); smoothing fully converged. See [before](websocket-public-before.json) and [after](websocket-public-after.json). These are functional stall probes from the workstation, **not Railway-vantage load measurements**.

Fixed raw snapshot correction distance p50 / p95 / max was **0 / 0 / 4.86 m** for the 1 s stall and **0 / 0 / 15.84 m** for the 2 s stall. Each run had two corrections above 1 cm across the stall plus six seconds of recovery (7 s and 8 s respectively). Reporting the maximum matters: the mostly-zero percentiles conceal the recovery event.

**Remaining limitation:** discarded movement time still produces large authoritative offsets. The deterministic blocked-upload case reaches 20.01 m. These offsets are smoothed, not eliminated, and can take several seconds to settle. This change removes prediction freezes and one-frame camera teleports; it does not make a stalled connection deliver missing movement or combat inputs. Eliminating that lost movement would require changing the bounded transport/server catch-up policy.

## Regression and verification

`npm run test:movement` runs six deterministic cases (1 s and 2 s, each with socket backpressure, hidden TCP queues, and upload-only stalls), using the production Network, binary codec and server simulation. It asserts:

- Every local simulation step advances while transport queues are full.
- Every 144 Hz render frame advances during the stall, with bounded displacement.
- A snapshot backlog cannot teleport the camera.
- Recovery corrections stay below 4.2 cm per render frame, then converge to authority rather than leaving a permanent visual offset.
- The transport queue limits remain unchanged.

An additional case checks that a key press is visible before the next physics/send tick without mutating prediction or queuing a packet. The network tests also exercise ten seconds of upload backpressure with bounded history and continuing stale snapshots, and verify newest control edges survive coalescing. [Deterministic measurements](after.json), [original deterministic measurements](before.json), and [real local WebSocket measurements](websocket-local.json) are included.

`npm test`: **100/100 pass** (82 existing tests, with the freeze assertion corrected, plus eight movement tests, seven connection/status tests, and three bot settings tests). `npm run build` and `npm run typecheck` pass.

For an isolated production server:

```sh
GAME_URL=http://127.0.0.1:8080 npm run test:movement:ws
MOVEMENT_REPORT=artifacts/movement/after.json npm run test:movement
```

## Load results and pending Railway verification

The fresh local matrices (2026-09-06, 13:05–13:08 UTC) ran 30 seconds per row with seven bots, against the built production HTTP/WS server. Local runtime: Node 25.9.0. Latency is added in **each direction**.

| Added one-way latency | Humans | Desyncs / replica errors | Worst client snapshot p99 | Upload per client | Prediction p99 |
|---|---:|---:|---:|---:|---:|
| 0 ms | 2 | 0 / 0 | 53 ms | 2.13–2.14 KB/s | 0 m |
| 0 ms | 5 | 0 / 0 | 52 ms | 2.12–2.13 KB/s | 0 m |
| 0 ms | 10 | 0 / 0 | 60 ms | 2.13–2.14 KB/s | 0 m |
| 80 ms | 2 | 0 / 0 | 54 ms | 2.13 KB/s | 0 m |
| 80 ms | 5 | 0 / 0 | 58 ms | 2.11–2.12 KB/s | 0 m |
| 80 ms | 10 | 0 / 0 | 58 ms | 2.13–2.14 KB/s | 0 m |

All rows passed the existing assertions, with 59.38–60.02 Hz server ticks. [0 ms report](load-local-0.json), [80 ms report](load-local-80.json), [compact summary](load-summary.json).

**The required remeasurement from inside Railway is still pending.** The saved CLI login expired; `railway status` reports `failed to refresh OAuth token: Operation not permitted (os error 1)` and `Unauthorized`. The sandbox cannot write `~/.railway/config.json`. These local results do not establish the Railway load constraint.

The calling agent can refresh Railway login outside the sandbox and run `/private/tmp/furo-fixes/railway-runner.py` from this linked checkout. It bundles the modified load and movement clients, launches them inside the deployed container against its public URL, and refuses to start if other players are connected. After approximately four minutes, invoke it with `--collect` to fetch the JSON reports. The server itself is unchanged, so this can validate the client before deployment.

## Version-control handoff

`.git` writes are blocked: `git add` fails creating `.git/index.lock` with `Operation not permitted`. The requested commit and push to `origin main` could not be performed. The reviewed changes are packaged as four sequential patches in `/private/tmp/furo-fixes/`; the calling agent must apply them to a clean checkout (or commit the existing working-tree changes), finish Railway validation, and push each item separately. Do not apply the patch again over the already modified working tree.
