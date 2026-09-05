# Krunker / Local Arena

A browser multiplayer FPS with a Three.js client and an authoritative Node/WebSocket server. The first screen is class selection and a live room roster; deploy directly into a match. All map geometry, movement, protocol types, and weapon statistics are shared TypeScript.

## Run locally

Node 22 or later is required.

```sh
npm install
npm run dev
```

Open **http://localhost:5173**. Vite proxies `/ws` and `/api` to the game server on port 3000. Open another browser/tab with the same room code to play together. On a LAN, use `http://<host-ip>:5173` on both machines. The host starts the first round. Bots fill five slots by default; the host can set 0–7 bots and Easy, Normal, or Hard before the match.

Share a room with `http://localhost:5173/?room=YOUR-ROOM`. Change the callsign or room code and press the arrow to reconnect. Each tab has its own reconnect token. Disconnected identities are retained for 20 seconds; empty rooms are removed after 30 seconds.

## Production / Railway

```sh
npm run build
PORT=8080 npm start
```

Open **http://localhost:8080**. This one HTTP server serves the compiled client, `/ws`, `/api/rooms`, and `/api/health`. `PORT` is read at startup; the server binds `0.0.0.0`. A multi-stage `Dockerfile` and `railway.json` are included. Railway can deploy the repository directly with its assigned `PORT`; no second service or port is needed. Rooms live in memory, so run one replica (multiple replicas would need room routing).

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

Audio unlocks on Deploy. Mouse sensitivity, master volume, and graphics quality are saved locally. Changing class during a live round applies on the next respawn. Reloads have unlimited reserve ammunition. The server has no fall damage. Spawn protection lasts 1.5 seconds and ends when firing. Death lasts 2.2 seconds.

## Game

- **Hunter**: Triangle .50 sniper, 60 HP, 3 rounds, 180 ms scope-in; lethal torso damage.
- **Triggerman**: 100 HP, 30-round assault rifle, predictable recoil and moderate spread.
- **Vince**: 100 HP, two-shell shotgun with eight server-traced pellets and steep range falloff.
- **Run N Gun**: 100 HP, faster movement, 34-round SMG with a 72 ms shot interval.
- Free-for-all and team deathmatch. First to 25 eliminations or four minutes; results last 12 seconds, then a fresh round starts automatically.
- Sandyard: three connected lanes, a raised central platform, three ramps, an underpass, long perimeter sightlines, containers, crates, and short-range corners.
- Block characters, animated first-person weapons, scope, muzzle flashes, tracers, impact marks, blood particles, synthesized weapon audio, hit sounds, headshot feedback, directional damage, health/ammo HUD, minimap, killfeed, scoreboards, and results.

## Architecture and netcode

`src/shared` holds protocol types, weapon/class stats, map data, collision, movement, and hitscan math. `src/server` holds the fixed-step simulation, rooms and transport, lag history, round logic, and bot navigation. `src/client` separates networking/prediction, controls, scene/map rendering, models, viewmodels, effects, audio, and UI.

- **60 Hz authoritative simulation**, **20 Hz snapshots**, inputs batched in pairs at 60 Hz.
- The client predicts with the same fixed-step movement function. Snapshots acknowledge an input sequence; pending inputs are replayed from authoritative state. Small corrections decay visually without altering collision state.
- Remote players interpolate 100 ms behind server time. Clock offset is estimated with ping/pong.
- The server rewinds hitboxes to the shot timestamp, constrained by its own measured connection RTT and a 250 ms maximum. History interpolation never crosses respawn generations. Static geometry still blocks shots.
- Delta snapshots contain only changed player fields and removed IDs, with periodic full keyframes. A broken baseline requests a full resync. Slow sockets cannot build an unbounded send queue.
- Server-side limits validate finite inputs, sequence monotonicity, movement time budgets, fire rate, magazine state, reload timing, team damage, line of sight, and spawn protection. Clients never submit positions, damage, health, or score.
- Bots use a walkable grid, visibility tests, reaction delays, aim error, strafing, cover selection while vulnerable, reloads, and stuck recovery. Their navigation currently favors the ground lanes.

## Verification

```sh
npm test
npm run test:integration
npm run test:soak
npm run typecheck
npm run build
```

Unit tests cover ray/hitbox and ramp math, damage zones, weapon falloff, spread/recoil, movement validation, deterministic movement, bunny hops and slides, ramp traversal, rewind interpolation and bounds, fire rate, reloads, respawn, spawn protection, friendly fire, round transitions, and bot pathing.

The integration test runs a real ephemeral HTTP/WebSocket server and two clients, sends actual input packets, and checks movement replication, all four primaries, damage to another connected client, headshot/kill events, reloads, respawn, historical hitscan, input rejection, round reset, reconnect identity, and delta compression. Deterministic test positions are set in the test process; the production protocol has no teleport or test endpoints.

The soak test advances a two-minute match with seven bots and validates finite states, bounds, movement, and combat activity.

Browser verification must be performed externally: this build environment cannot launch a browser. For live FPS and renderer counters, inspect `window.__arena.metrics`; `window.__arena.state` exposes client state for inspection. The HUD also shows FPS and ping. `/api/health` reports measured server tick rate and simulation costs. No client FPS or visual fidelity claim should be inferred from headless tests.

## Visual reference notes

The implementation uses original geometry and generated audio, informed by direct reference-image inspection of [early Burg gameplay](https://thekoalition.com/2018/introducing-krunker-io-another-member-of-io-games-family) and [later sniper gameplay](https://krunker.cc/wp-content/uploads/2024/10/Krunker-Gameplay-1024x614.jpg). These guided the boxy architecture, angular oversized viewmodels, team silhouettes, flat HUD, stacked killfeed, lime health bar, and yellow headshot feedback. Sandyard is an original layout. This is a Krunker-style recreation, not the original game code or an exact reproduction of its undocumented movement/audio behavior.

Barlow fonts are self-hosted under the SIL Open Font License; see `public/fonts/OFL.txt`. No gameplay assets require external network requests.
