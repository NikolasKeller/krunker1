# Furo / Local Arena

A browser multiplayer FPS with a Three.js client and an authoritative Node/WebSocket server. Create a private lobby, copy its five-character invite URL, choose a class/team, and ready up with up to ten friends plus seven bots. All map geometry, movement, protocol types, and weapon statistics are shared TypeScript.

## Run locally

Node 22 or later is required.

```sh
npm install
npm run dev
```

Open **http://localhost:5173**. Vite proxies `/ws` and `/api` to the game server on port 3000. Click Create Lobby and share the generated `/?room=AB7K4` URL. Opening an invite joins that lobby directly. On a LAN, use `http://<host-ip>:5173` on both machines. The last ready player triggers a shared three-second countdown. The host can start early; match settings (mode, score/time limit, bots) reset readiness. Bots fill five slots by default. The visible **Room bots** controls let the host select **No bots (friends only)** for a private 1v1, or 1–7 bots with Easy, Normal, or Hard difficulty. Everyone joining the invite receives the same room settings, which persist through the match and rematches. Only the host can change them in the lobby.

Share a room with `http://localhost:5173/?room=YOUR-ROOM`. Edit your callsign in the lobby; duplicates receive a numbered suffix. Join another room by code or create a new lobby in the room panel. Each tab has its own reconnect token. Disconnected identities are retained for 20 seconds; empty rooms are removed after 30 seconds. Disconnected players disappear from the roster immediately; host ownership passes to the next connected player. At capacity, a new friend can take a disconnected slot.

## Production / Railway

```sh
npm run build
PORT=8080 npm start
```

Open **http://localhost:8080**. This one HTTP server serves the compiled client, `/ws`, `/api/rooms`, and `/api/health`. `PORT` is read at startup; the server binds `0.0.0.0`. A multi-stage `Dockerfile` and `railway.json` are included. Railway can deploy the repository directly with its assigned `PORT`; no second service or port is needed. The lobby displays LAN URLs from `/api/connection` and the public invite URL. Railway supplies `RAILWAY_PUBLIC_DOMAIN`; set `PUBLIC_URL=https://your-domain.example` for a custom public origin. Rooms live in memory, so run one replica (multiple replicas would need room routing).

## Controls

| Input | Action |
| --- | --- |
| WASD / mouse | Move / look |
| Left / right mouse | Fire / aim; scope with the sniper |
| Space | Jump; tap again near landing for a timed bunny hop |
| Shift | Slide; tap just before landing, then quickly jump to build speed |
| R | Reload |
| 1 / 2 / 3 | Class primary / sidearm / knife |
| Tab | Live scoreboard |
| Esc | Release pointer lock and open pause menu |

Audio unlocks on Ready or Click to Play. When the countdown ends (or an invite joins a running match), everyone enters the match together. Click to Play captures the mouse; browsers require this user gesture. Mouse sensitivity, master volume, and graphics quality are saved locally. Changing class during a live round applies on the next respawn. Reloads have unlimited reserve ammunition. The server has no fall damage. Spawn protection lasts 1.5 seconds and ends when firing. Death lasts 2.2 seconds.

## Game

- **Hunter**: Triangle .50 sniper, 60 HP, 3 rounds, 180 ms scope-in; lethal torso damage.
- **Triggerman**: 100 HP, 30-round assault rifle, predictable recoil and moderate spread.
- **Vince**: 100 HP, two-shell shotgun with eight server-traced pellets and steep range falloff.
- **Run N Gun**: 100 HP, faster movement, 34-round SMG with a 72 ms shot interval.
- Free-for-all and team deathmatch. Default: first to 25 eliminations or four minutes, configurable by the host. Results return everyone to the same lobby; after six seconds players can ready up for a new round. Results remain visible until that round starts.
- Sandyard: three connected lanes, a raised central platform, three ramps, an underpass, long perimeter sightlines, containers, crates, and short-range corners.
- Block characters, animated first-person weapons, scope, muzzle flashes, tracers, impact marks, blood particles, synthesized weapon audio, hit sounds, headshot feedback, directional damage, health/ammo HUD, minimap, killfeed, scoreboards, and results.

## Architecture and netcode

`src/shared` holds protocol types, weapon/class stats, map data, collision, movement, and hitscan math. `src/server` holds the fixed-step simulation, rooms and transport, lag history, round logic, and bot navigation. `src/client` separates networking/prediction, controls, scene/map rendering, models, viewmodels, effects, audio, and UI.

Startup paints the Furo loading screen directly from `index.html`, using inline styles and system fonts. The small entry module imports the lobby and its stylesheet; Three.js and the game scene load after the lobby has painted. Players can choose a class, create/join a room, configure it and invite friends while the arena loads. Ready, Join Match and Start Early wait for the first successful rendered frame. The progress bar tracks completed startup stages (document, lobby, game), rather than estimating download percentages. Missing files, initialisation errors, WebGL failures and a 90-second startup timeout share the same reload screen. Browser timing marks are `furo-lobby-ready` and `furo-game-ready`.

Movement and collision use shared TypeScript; no external physics engine or WASM is shipped. Rapier in the lockfile is a development dependency of `@types/three`. Production builds precompress HTML, JavaScript, CSS, fonts and any WASM assets with Brotli/gzip. The HTTP server negotiates these files without runtime compression, varies responses by encoding, caches hashed assets for one year, and revalidates HTML with ETags. See [startup verification](artifacts/startup/README.md) for sizes, tests and the external browser measurement status.

- **60 Hz authoritative simulation**, **20 Hz snapshots**, and **20 Hz binary input packets** carrying 60 Hz simulation steps.
- The client predicts with the same fixed-step movement function. Snapshots acknowledge an input sequence; pending inputs are replayed from authoritative state. Small corrections decay visually without altering collision state. Inputs carry the current life generation so delayed pre-death input cannot move or fire after a respawn.
- Clients predict at 60 Hz and send at most 12 simulation steps per packet at 20 Hz, independently of rendering. Unsent inputs and independent prediction history retain 600 steps; up to 360 steps may be in flight. Ordered backlog recovery preserves movement through four-second outages. Fractional-step previews respond at render rate; same-contact cosmetic discrepancies are suppressed and remaining corrections are smoothed at at most 0.6 m/s with collision clipping. Movement collision substeps stay at or below 10 cm even at the 28 m/s speed cap.
- The `arena-v3` WebSocket subprotocol adds the sampled interpolation delay to binary inputs. Packets are at most 446 bytes; the server accepts messages up to 4 KB. Cached `arena-v2` binary and older JSON clients still connect, but need a reload to get adaptive shot compensation. Snapshots remain 20 Hz; remote interpolation reserves 100–500 ms based on measured delivery jitter, plus half RTT (up to 500 ms). Playback changes speed smoothly as the reserve adapts, extrapolates for at most 250 ms through shared collision, then blends back to snapshots. Body, nameplate and health use one render sample. Clock offset is estimated with ping/pong.
- The server banks at most 600 elapsed movement ticks and processes at most 12 commands per actor per tick. It retains unprocessed movement and advances human physics only with acknowledged commands. Snapshot sends skip busy sockets without advancing their delta baseline. `/api/health` exposes send cadence, write callback duration, buffered bytes and input arrival/queue measurements.
- Admission allows 30 seconds for the WebSocket upgrade and another 30 seconds for the lobby assignment. Join and reconnect retries use exponential backoff with jitter. A five-second snapshot stall reports **Connection slow** and requests fresh state; any server traffic keeps an established session alive, with reconnection only after 45 seconds of complete silence or a closed transport.
- Local firing immediately creates tracers, muzzle flash, shell ejection, recoil and static impacts using shared weapon math. Server shot events quietly correct impact positions; damage, blood and hitmarkers remain authoritative.
- The server rewinds hitboxes on the same 20 Hz snapshot timeline the client renders. The budget includes the actual playback delay (validated at 0–1000 ms), half the measured RTT and 150 ms for input batching/clock error, capped at **1500 ms total**. Legacy inputs retain their 250 ms ceiling. History never crosses respawn generations; static geometry still blocks shots. Fire queued for more than **1000 ms since sampling**, or targeting history older than 1500 ms, expires without spending ammo. Its movement still runs and its sender sees **“Shot expired during connection delay. Fire again.”** Four-second outages intentionally cannot deliver retroactive damage. See [the hitscan measurements and policy](artifacts/hitscan/README.md).
- Delta snapshots contain only changed player fields and removed IDs, with periodic full keyframes. Remote positions use centimetres and angles use milliradians; local movement retains exact double precision for prediction. Remote snapshots omit private prediction/ammo fields. Room metadata is sent only on changes. A broken baseline requests a full resync. Slow sockets cannot build an unbounded send queue.
- Server-side limits validate finite inputs, sequence monotonicity, movement time budgets, fire rate, magazine state, reload timing, team damage, line of sight, and spawn protection. Clients never submit positions, damage, health, or score.
- Bots use a precomputed graph of ground and elevated surfaces, visibility tests, reaction delays, aim error, strafing, cover selection while vulnerable, reloads, and stuck recovery. Their navigation connects the ground lanes, all three ramps and the upper deck while preserving the bridge underpass.

## Verification

```sh
npm test
npm run test:integration
npm run test:hitscan:ws
npm run test:lobby
npm run test:lobby:flow
npm run test:soak
npm run test:lifecycle
npm run typecheck
npm run build
```

The test suite includes deterministic 1–4 second admission delays, 1–2 second movement stalls, visible host bot controls, difficulty behavior, and room settings through invites and rematches. Unit tests also cover ray/hitbox and ramp math, damage zones, weapon falloff, spread/recoil, movement validation, deterministic movement, bunny hops and slides, ramp traversal, rewind interpolation and bounds, fire rate, reloads, respawn, spawn protection, friendly fire, round transitions, and bot pathing.

The integration test runs a real ephemeral HTTP/WebSocket server and two clients, sends actual input packets, and checks movement replication, all four primaries, damage to another connected client, headshot/kill events, reloads, respawn, historical hitscan, input rejection, round reset, reconnect identity, and delta compression. Deterministic test positions are set in the test process; the production protocol has no teleport or test endpoints.

`npm run test:production` targets an already running production server at `http://127.0.0.1:8080` (override with `GAME_URL`) and verifies asset serving and two independent clients navigating and killing through input packets only. See [VERIFICATION.md](VERIFICATION.md) for measured results and the remaining external browser checks.

`npm run test:lobby:flow` starts its own real server and two isolated Node processes, each with its own jsdom, production UI/Network classes, storage and WebSocket. They click create/join/ready/start controls and assert replicated readiness, countdown deadlines, actual match starts, host permissions and host migration. Run `GAME_URL=http://127.0.0.1:8080 npm run test:lobby:flow` against an already running production server. It uses no browser, WebGL, or CDP. The lobby polls independently at 10 Hz and writes only changed values; inspect `window.__arena.metrics.lobby` for poll/update/write counts.

The soak test advances two minutes with seven bots and validates finite states, movement, and combat activity. `test:lobby` covers live readiness, countdowns and cancellation, settings ownership, host handover, duplicate names, late join, reconnects, results/rematches, room capacity, and replacement of a disconnected slot.

With a built production server running on port 8080, run the real-time acceptance load:

```sh
LOAD_REPORT=artifacts/load-local.json npm run test:load
LOAD_COUNTS=10 LOAD_LATENCY_MS=40 LOAD_REPORT=artifacts/load-latency.json npm run test:load
```

The load runner shares the production binary codec and input buffer; its original acceptance thresholds are unchanged. See [NETCODE.md](NETCODE.md) and [raw network measurements](artifacts/netcode) for public-deployment verification.

The default run measures 2, 5, and 10 independent simulated clients, each alongside **seven server bots**, for 30 seconds per case. Override `GAME_URL`, `LOAD_SECONDS`, `LOAD_COUNTS`, and `LOAD_BOTS` as needed. Use an isolated server with no other human connections during measurements. The clients predict movement, navigate and shoot through real packets; the test checks replica agreement, snapshot continuity, input backlog, prediction error, movement, combat, server tick cost, and inbound/outbound bandwidth (including WebSocket framing). `LOAD_LATENCY_MS` adds application-level one-way delay in both directions. Death corrections are reported separately from continuous movement prediction.

`npm run preview:geometry` generates `artifacts/geometry-preview.png` with a small software rasterizer. It helps inspect geometry and weapon framing without a browser, but does **not** verify WebGL lighting, shadows, HUD layout, pointer lock, audio, or GPU FPS.

Browser verification must be performed externally: this build environment cannot launch a browser. For live FPS and renderer counters, inspect `window.__arena.metrics`; `window.__arena.state` exposes client state for inspection. The HUD also shows FPS and ping. `/api/health` reports measured server tick rate and simulation costs. No client FPS or visual fidelity claim should be inferred from headless tests.

## Visual reference notes

The implementation uses original geometry and generated audio, informed by direct reference-image inspection of [early Burg gameplay](https://thekoalition.com/2018/introducing-krunker-io-another-member-of-io-games-family) and [later sniper gameplay](https://krunker.cc/wp-content/uploads/2024/10/Krunker-Gameplay-1024x614.jpg). These guided the boxy architecture, angular oversized viewmodels, team silhouettes, flat HUD, stacked killfeed, lime health bar, and yellow headshot feedback. Sandyard is an original layout. Furo is an original browser arena shooter with its own movement and audio implementation.

Squada One is bundled and preloaded locally for the HUD and menus; see [font source and license](public/fonts/README.md). No gameplay assets require external network requests. The minimap defaults to off to keep the reference's clear upper-left view; enable it in Settings. A hidden minimap performs no canvas drawing.

`npm run preview:hud` exports standalone `artifacts/hud-preview/{lobby,ffa,tdm,body-hit,headshot,multikill}.html` pages using the actual UI markup, stylesheet and embedded font. The combat fixtures freeze the yellow damage animation 150 ms into its lifetime and display the hitmarker; lethal hits also show the kill notice. They use a software geometry backdrop and require an external browser to verify layout; they do not connect to or change a live match. Capture them at 1024×614 to compare with the supplied reference, then check the deployed lobby and match at 1280×800 for clipping.

`tests/hud.test.ts` loads the production stylesheet in jsdom and checks yellow body/head damage, white HEADSHOT with yellow +50, multi-kill text, hitmarker visibility/colour/expiry, and a deterministic aimed server headshot in team deathmatch. Team numbers are authoritative team **kill counts**, matching this game's TDM rules. An injected 175-damage event renders `+175`; actual damage is capped to the target's remaining HP (for example, `+60` against a full-health Hunter). This polish pass does not change damage or scoring rules.

`tests/hud-network.test.ts` also fires an aimed authoritative headshot through a real server and two production Network clients using binary WebSockets. It asserts the resulting HUD damage, hitmarker, headshot bonus and team score; the victim receives the same events without personal hit/kill feedback. TDM's personal elimination counter remains hidden when kill feedback expires and when switching modes.

Movement stall evidence, the latest local matrix and the pending Railway verification are documented in [the movement report](artifacts/movement/README.md).

The latest collision, shot feedback, remote interpolation and viewmodel changes are documented in [the playtest fix report](artifacts/playtest-fixes/README.md), including local load results and the pending Railway verification.
