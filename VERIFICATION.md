# Verification record

Checks run locally on 2026-09-05. Browser launch and browser debugging connections are prohibited in this workspace; no browser screenshots or client frame-rate measurements were produced.

## Completed

- 31 simulation/prediction tests: ray intersections, head/body/leg hitboxes, ramp occlusion, weapon damage/falloff, deterministic spread, recoil bounds, invalid input rejection, server movement budget, shared movement/reconciliation, jumping, timed slide hops, wall collisions, ramp traversal, bridge underpass, rewind interpolation/life boundaries/time bounds, fire cadence, reloads, friendly fire, spawn protection, respawn, round transitions, bot fill and pathing, room-switch sequence reset and missing-delta resync.
- 2 scene-construction tests: all class/weapon geometry builds; no non-finite vertex data; visible ramp height matches collision. Static map: **37 meshes / 4,024 triangles**. These are geometry tests, not GPU rendering tests.
- Real WebSocket integration: two clients see each other move, all four primary weapons damage the other client, headshot/kill events reach both clients, reloads complete, respawn protects the victim, historical hitboxes register a shot, impossible input is rejected, rounds end/restart, reconnect preserves identity.
- Integration measurement: **59.9–60.0 Hz**, around **0.10–0.24 ms average server tick processing**, **0.83–1.05 ms peak** with two clients. Example deltas: **468 bytes** versus **1,611 bytes** per full snapshot (this is a two-client test, not a full-room bandwidth estimate).
- Two-minute simulated seven-bot match: all bots moved, **354 hits / 101 eliminations**, **0.197 ms average / 2.893 ms peak simulation tick**. This fast-forward test measures simulation cost, not real-time tick frequency.
- Lifecycle test: disconnected identity expires after 20 seconds; empty room and bot state are subsequently removed.
- A clean `npm ci` succeeded in an isolated directory. `npm test` passed all 33 tests. TypeScript check and production client build passed. Client bundle: approximately **574 kB JS / 151 kB gzip**, plus **24 kB CSS / 6 kB gzip** and local fonts.
- Actual built production server started with **PORT=8080**. HTML, bundled assets, fonts, and WebSockets served on that single port.
- Two independent clients joined that built server, navigated around the map using only input packets, met in a firing lane, registered a headshot kill, and respawned. No server-side test fixture was used for this production smoke test. Measured **60 Hz**, **0.203 ms average tick / 0.869 ms peak**.

## External browser check still needed

Open `http://localhost:5173` (development) or `http://localhost:8080` (production). Check class selection, pointer lock, map visibility, weapon framing, audio, readable HUD/scoreboard, reload animation, two visible browser players, and resizing. Test at 1440×900 on the target integrated GPU.

The HUD reports real elapsed-time FPS and ping. `window.__arena.metrics` exposes FPS, draw calls, triangles, pending input count and reconciliation counters. `window.__arena.state` exposes current client state. Client FPS has **not** been measured here.

The implementation was informed by directly inspected Krunker reference images. The map layout, procedural models, and synthesized audio are original. Exact pixel matching and identical original-game movement/audio timing are **not verified**. Bots currently prefer the ground routes.
