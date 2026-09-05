# Verification record

Verified on 2026-09-05 using Node 25.9.0 on the local macOS host. No browser, Chromium, or CDP connection was launched. GPU FPS and browser appearance are not inferred from these results.

## Lobby DOM regression

The old render-driven UI replaced the primary button's children every 90 ms (about 11 times/second) and repeatedly rebuilt results. The lobby now has an independent 100 ms timer (10 polls/second), persistent buttons/inputs, keyed player/result rows, and writes only changed values. Countdown text changes once per displayed second. `window.__arena.metrics.lobby` reports `intervalMs`, `polls`, `updates` (polls that changed the DOM), and `writes`.

Node DOM tests observed **zero mutations over 100 unchanged polls**, including unrelated player-position changes. They retain the button, its text target, every form control, and existing roster/results rows; callsign focus, draft value, selection direction and caret survive readiness/team/countdown updates. These use jsdom, not a browser. The build and **49 tests** passed, including all 39 original tests and seven ready/countdown state-machine regressions.

## Production acceptance

- `package-lock.json` is tracked on `origin/main`. A fresh `npm ci` in an isolated checkout succeeded with zero reported vulnerabilities. The original missing-lockfile blocker is resolved in the repository.
- `npm run build` passed TypeScript, Vite client compilation and esbuild server bundling. `PORT=8080 npm start` ran the actual built entry point, bound to **0.0.0.0:8080**; its default is port 3000 when `PORT` is absent.
- `npm run test:production` verified HTTP 200 for the page, compiled JS/CSS, self-hosted fonts and favicon. It reads the healthcheck path directly from `railway.json` and verifies HTTP 200 and `ok: true` at `/api/health`.
- Two independent WebSocket clients connected to **that same port**, navigated using input packets, met in a firing lane, registered a headshot elimination and respawned. No test/teleport endpoint was used. `/api/connection` supplies LAN origins and the configured public origin.
- A separate fresh `npm ci --omit=dev` installed only the two production packages. The built server started from that isolated directory on port 8081, and the same asset/health/WebSocket navigation, elimination and respawn checks passed (60 Hz; 0.216 ms mean / 0.729 ms peak in the final health sample). No dev dependency was available to that server.
- The Dockerfile uses Node 22 and includes the lockfile in both `npm ci` stages. Docker is not installed here, so the container build and Railway-hosted runtime are not claimed as tested. Run one Railway replica because rooms are in memory.

## Real-time load measurements

Each row used real independent WebSocket connections to the built production server, with **seven additional server bots**. After a warmup, each case ran 30 seconds with client prediction, navigation and continuous combat. The benchmark rejects other human connections on the server during measurement. Tick duration includes simulation, snapshot serialization and outbound event dispatch.

| Humans + bots | Tick Hz | Mean tick ms | Highest window p95 ms | Peak tick ms | Receive KB/s per client |
| --- | ---: | ---: | ---: | ---: | ---: |
| 2 + 7 | 60.02 | 0.979 | 2.633 | 11.735 | 18.80–18.97 |
| 5 + 7 | 60.00 | 1.196 | 3.254 | 4.456 | 23.53–23.66 |
| 10 + 7 | 59.98 | 1.614 | 4.771 | 5.876 | 33.15–33.39 |

All three cases passed: **zero replica mismatches, zero desyncs, zero disconnects, zero queued outbound bytes, and zero ticks above the 16.67 ms processing budget**. Every simulated human moved and fired. At ten humans, the test observed 597 human shots, a maximum snapshot gap of 55 ms, and a worst-client ongoing-movement prediction p99 of 0.0286 m. Send traffic was 13.80–14.35 KB/s per client. Bandwidth includes WebSocket frame headers, excluding TCP/IP/TLS overhead.

The additional **ten humans + seven bots with 40 ms application delay each way (80 ms simulated round trip)** passed at 60.00 Hz, 1.941 ms mean / 6.389 ms peak tick, and 32.89–33.17 KB/s received per client. Worst-client ongoing-movement prediction p99 was 0.0001 m; no desyncs or replica mismatches occurred. This tests injected application delay, not a real WAN with packet loss or jitter.

The latency test exposed buffered inputs crossing respawns. Inputs now carry a life generation and stale inputs are acknowledged without moving or firing the new character. Death-position corrections are reported separately: clients cannot predict the authoritative time of death. The metric for ongoing movement includes corrections after respawning.

Raw results, including individual clients and thresholds: [local load](artifacts/load-local.json), [latency load](artifacts/load-latency.json). These measure server and protocol performance, not client GPU frame rate.

## Gameplay and lifecycle

- **39 unit/geometry tests passed**, including all weapon damage/spread/recoil, movement and collision, slide hops, ramps, lag rewind, prediction replay, stale-life input rejection, spawn safety, rounds, and bot navigation.
- Real WebSocket lobby test passed invite generation, duplicate-name suffixes, live name/team/readiness, host-only settings, all-ready countdown, unready/new-arrival cancellation, unready disconnect, host migration, late spawn, reconnect identity, results/lobby/rematch, ten-human capacity plus seven bots, and replacement of a disconnected slot.
- Real combat integration passed all four primaries, authoritative movement, kills/headshots, reloads, respawn, spawn protection, historical hitscan, malformed input rejection, round/lobby reset and reconnect.
- Disconnect lifecycle passed immediate roster removal, 20-second identity expiry and eventual empty-room cleanup.
- Two simulated minutes with seven bots produced **338 hits / 101 eliminations**; all seven bots moved. Approximately **0.118 ms average / 2.191 ms peak** per simulated tick in that run. This is a simulation throughput check, separate from the real-time benchmark above.

## Rendering and external handoff

Camera pitch now agrees with authoritative hitscan. A regression test projects shots to the centre of the camera across multiple pitch/yaw combinations. Team and class changes rebuild the correct remote appearance. The map has **42 meshes / 6,726 triangles**; sixteen remote characters use **96 meshes total** (six each, including weapons), with vertex colours retaining the palette. Renderer diagnostics now count all render passes.

The map, models, HUD and viewmodel framing were compared with the [Krunker sniper reference](https://krunker.cc/wp-content/uploads/2024/10/Krunker-Gameplay-1024x614.jpg). Added facade detail, paving fragments and cargo signage; corrected floating side doors and reduced the oversized scope framing. [Geometry preview](artifacts/geometry-preview.png) is generated by `npm run preview:geometry`, a software rasterizer. It is **not a browser screenshot** and omits HUD layout, WebGL lighting/shadows and canvas sign text.

External browser check: open `http://localhost:8080`, create a lobby, copy the invite into other browsers, choose teams and ready up. Check the roster and countdown, click to capture the mouse when the round goes live, test aiming/fire/reload/scope/audio and player visibility, then verify results/rematch, resizing, and ten actual human clients. Browser user activation is required to capture the mouse; the server still starts everyone on the same simulation tick.

`window.__arena.metrics` exposes FPS, draw calls, triangles, ping, pending inputs and reconciliation counters. `window.__arena.state` exposes the current room/player state. Browser frame rate, exact visual matching and real-world WAN smoothness remain for that external check.
