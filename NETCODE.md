# Public netcode measurements

**Current working-tree changes:** [playtest fixes and measurements](artifacts/playtest-fixes/README.md) add bounded collision substeps, swept camera clipping, predictive shot visuals and adaptive remote rendering. That report distinguishes local measurements from pending Railway verification.

**Historical bandwidth report.** The later [movement stall fix](artifacts/movement/README.md) replaces the prediction reset on dropped inputs described below with independent replay history and smooth correction; it also adjusts remote interpolation. The Railway results here predate that fix.

Target: `https://krunker1-production.up.railway.app`. All measurements in this report use that public HTTPS/WSS address. Local unit/integration tests are listed separately. No browser launch or CDP connection was used.

## Changes

- `211a98d`: instrument production snapshot cadence, send callbacks, socket buffers, input arrival gaps and input queue depth; expose the deployed Git revision in health responses.
- `99522dd`: negotiate `arena-v1`; encode input, player deltas and combat events as binary; retain JSON control messages and legacy JSON compatibility. Share the browser's 20 Hz sender and bounded input buffer with the load runner. Each packet preserves intervening 60 Hz simulation steps, including button transitions. Quantize controls before prediction to match the wire representation.
- `7f585d7`: save up to 12 input-processing credits across delivery jitter, retain the three-step per-tick catch-up limit, accept legitimate sequence gaps, and reject malformed batches atomically.
- `d81986d`: discard stale server inputs after each simulation budget, retaining a recent 200 ms window. Cap receive bursts without disconnecting clients for valid but delayed inputs.
- `5b191c9`: preserve exact local prediction state at collision contacts; negotiate `arena-v2` with compatible JSON fallback for cached clients.
- `8a452c6`: also bound inputs buffered beyond the local socket using a 30-step acknowledgement window, and immediately rebuild prediction when unsent controls are discarded.

The transmission window also persists across respawns. The server acknowledges received commands it discards on a new life, releasing their credit without simulating stale movement.

The final protocol, `arena-v2`, additionally retains exact double precision for the local player while remote-player deltas remain compact. An explicit crate-contact regression reproduced a 1.45 m collision discrepancy from float32 rounding; the exact local snapshot removes it. Cached `arena-v1` clients receive compatible JSON snapshots until they refresh. The first public 10-client runs exposed this through the unchanged prediction-error assertion (see the `public-before-precision-*` artifacts).

The client retains at most 12 unsent inputs and 120 prediction inputs. It sends no new input packet while its WebSocket write queue is nonempty or when sending would exceed 30 unacknowledged inputs. This second limit covers data already handed to a kernel or proxy, which `bufferedAmount` cannot see. Under a stalled acknowledgement stream, retained prediction input stays within the 30 transmitted plus 12 unsent steps; discarded controls no longer keep advancing the predicted player. The server keeps the last transmitted snapshot baseline when skipping a congested socket, so the next delta spans skipped states. Normal input packets contain roughly three steps; even the maximum batch is only 398 bytes. The inbound payload ceiling is now 4096 bytes, compared with 16384 previously.

The simulation already ran at 60 Hz and snapshots already ran at 20 Hz. Snapshot frequency was not the original problem; the code now uses the existing `SNAPSHOT_RATE` constant instead of a hard-coded tick divisor. Remote interpolation remains 100 ms.

`tests/load.ts` retains every original assertion and threshold. Its wire adapter now exercises the production codec and queue. Additional report fields expose server cadence and actual queue occupancy; ack lag is still measured as generated sequence minus authoritative acknowledgement, without clamping.

## Diagnosis before changing transport

The original command failed in its first two-human stage. This reproduction recorded 18.31–18.48 KB/s down, 14.07–14.12 KB/s up, maximum ack lag 204–237, and maximum snapshot gaps 895–1888 ms. Both clients reported zero desyncs. See [baseline.json](artifacts/netcode/baseline.json).

An instrumentation-only deployment reproduced the failure and measured:

| Metric | Maximum |
| --- | ---: |
| Server snapshot generation/send gap | 57 ms |
| Server WebSocket write callback | 3.819 ms |
| Server WebSocket buffered output | 0 bytes |
| Skipped server snapshots | 0 |
| Input message | 511 bytes |
| Server input arrival gap | 2931 ms |
| Client delivery jitter beyond server send interval | 1898 ms |
| Server input queue | 120 steps |

See [diagnostics.json](artifacts/netcode/diagnostics.json). The server was generating and handing off snapshots promptly. Neither its batching interval nor the 256 KB backpressure threshold caused those observed stalls. The 16 KB inbound payload limit was also not being reached. Lower queue limits address behavior when a socket actually backs up; they cannot remove bytes already buffered downstream of the server.

Minimal 20 Hz ping/pong probes with no joined room reproduced multi-second gaps from the workstation with both `ws` and Node's native WebSocket. Padding requests did not fix them. The same public endpoint probed from Railway recorded p99 RTT 8 ms and maximum delivery gap 62 ms. These observations identify an origin-dependent transport delay; they do not identify a particular router or prove that every Railway edge behaves identically. See [ping-probes.json](artifacts/netcode/ping-probes.json).

## Reproduction

```sh
GAME_URL=https://krunker1-production.up.railway.app LOAD_COUNTS=2,5,10 LOAD_SECONDS=30 LOAD_BOTS=7 LOAD_REPORT=/tmp/load-report.json npm run test:load
GAME_URL=https://krunker1-production.up.railway.app LOAD_COUNTS=2,5,10 LOAD_SECONDS=30 LOAD_BOTS=7 LOAD_LATENCY_MS=80 LOAD_REPORT=/tmp/load-report-80.json npm run test:load
GAME_URL=https://krunker1-production.up.railway.app npm run test:lobby:flow
```

The load runner requires an isolated server. An attempted workstation 80 ms run was rejected by its unchanged isolation assertion because three other humans were connected (5 total instead of 2). Those connections were not terminated by the tests.

For the separate Railway-origin measurements, `tests/load.ts` is bundled with esbuild (Node platform, ESM, external packages) and run with Node 22 inside the service, connecting through the public HTTPS/WSS URL. Both matrices use exactly 2/5/10 humans, 7 bots and 30 seconds per stage. The 80 ms setting adds one-way application latency in both directions; it does not simulate packet loss. These are reported separately from the workstation-origin results, because a nearby runner cannot demonstrate that the workstation's route has recovered.


## Public results and remaining acceptance failure

Final functional revision: `af0af0fc265147f516fb86b16cfce7827d3798e5`.

The final 80 ms public matrix and the single repeat of the zero-latency matrix passed from the Railway-origin runner. The first final zero-latency matrix passed its 2- and 5-human stages, then failed at 10 humans because one client had a 579 ms snapshot gap; all other clients in that stage stayed at or below 66 ms, prediction p99 was at most 0.001 m, and desyncs were zero. That failure is retained in [public-final-stall-0.json](artifacts/netcode/public-final-stall-0.json). A single repeat of the complete zero-latency matrix was made without code or threshold changes.

The following table shows the latest complete reports (worst client per stage), each with seven bots and 30 seconds per stage. The zero-latency rows use the successful repeat.

| Added one-way latency | Humans | Down KB/s | Up KB/s | Maximum ack lag | Snapshot gap p99 ms | Maximum gap ms | Desyncs |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 ms | 2 | 8.27 | 2.14 | 5 | 54 | 67 | 0 |
| 0 ms | 5 | 9.99 | 2.14 | 6 | 54 | 61 | 0 |
| 0 ms | 10 | 13.45 | 2.14 | 6 | 57 | 65 | 0 |
| 80 ms | 2 | 8.08 | 2.14 | 15 | 54 | 107 | 0 |
| 80 ms | 5 | 10.48 | 2.13 | 15 | 56 | 67 | 0 |
| 80 ms | 10 | 13.83 | 2.14 | 15 | 59 | 68 | 0 |

Reports: [successful final 0 ms repeat](artifacts/netcode/public-final-repeat-0.json), [initial final 0 ms run](artifacts/netcode/public-railway-0.json), [final 80 ms run](artifacts/netcode/public-railway-80.json). The earlier `5b191c9` matrices also passed both 0 and 80 ms runs and are retained in the `public-before-window-*` files. An interrupted `8a452c6` run is retained separately. Test origins and revisions are recorded in the artifacts.

**Acceptance on the original workstation route remains unmet.** The final normal run stopped at two humans on the ack-lag assertion; the final 80 ms run passed that ack-lag check but failed the snapshot-stall assertion. Actual retained queues stayed bounded at 30 transmitted plus 12 unsent inputs (42 prediction inputs). Both runs had zero desyncs and prediction p99 below 0.04 m.

| Workstation added latency | Max ack lag | Snapshot gap p99 ms | Maximum gap ms | Down KB/s | Up KB/s |
| --- | ---: | ---: | ---: | ---: | ---: |
| 0 ms | 137 | 453 | 2099 | 8.22 | 1.87 |
| 80 ms | 76 | 437 | 963 | 7.4 | 1.96 |

See [final workstation 0 ms](artifacts/netcode/public-final-workstation-0.json) and [final workstation 80 ms](artifacts/netcode/public-final-workstation-80.json). The sequence counter continues advancing through dropped controls, so a large ack-lag value does not imply those dropped inputs remain queued; it still correctly exposes unacceptable delivery delay. No assertions or thresholds were weakened.

The results from a nearby Railway runner demonstrate deployed behavior through the public endpoint under the requested artificial latency. They do not establish that the workstation-to-edge path meets the requested gap limits. Minimal ping/pong traffic also reproduced the origin-dependent delay. The exact network component causing it has not been isolated.

A remote attempt was interrupted by `WebSocket error: tungstenite error` and an expired CLI login whose refresh could not write the sandbox's read-only `~/.railway/config.json`. The login subsequently refreshed. Final remote runs were detached from the SSH control channel so that losing the control connection would not terminate the benchmark.

## Other verification

- `npm test`: 69 tests pass, including malformed binary frames, full/delta reconstruction, exact crate-contact prediction, jitter recovery, sequence gaps, blocked socket buffers, blocked acknowledgements, discarded-input prediction and respawn credit.
- `npm run build`: passes.
- `npm run test:integration`: passes after the final lifecycle fix, including movement, all weapons, damage, reloads, respawns, rewind, results and reconnects.
- Lobby state, soak and lifecycle suites passed during the transport work.
- Public `test:lobby:flow`: three consecutive passes after the binary transport deployment and subsequent passes on `8a452c6` and final revision `af0af0f`. These use isolated Node processes with the production UI/Network classes and real WebSockets; they are not newly launched browsers.
- Every original assertion in `tests/load.ts` was compared with the baseline commit and remains unchanged.

Commits were created and pushed through `/tmp/krunker-netcode` because the workspace's `.git` directory is read-only. Each functional revision was deployed through the authorized push-to-main workflow and re-measured through the public endpoint. Reload existing game tabs to use the new binary client; cached clients retain compatible JSON snapshots.
