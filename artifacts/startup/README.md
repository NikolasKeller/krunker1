# Startup loading and delivery

Base revision: `76136cfc6e607b18ecbfe1f450678d7eb58d90b7`. Changes are in the working tree; deployment and the browser remeasurement belong to the calling agent. This sandbox did not launch a browser or connect to CDP.

The initial HTML contains the dark Furo screen, green wordmark, loading text and determinate progress element, styled entirely inline with system-font fallbacks. An inline guard installed before the module handles a failed entry request, stylesheet/chunk failure, initialisation exception, WebGL failure and a 90-second timeout. The reload button preserves the invite URL. Room context is set when the document becomes interactive, without waiting for module execution. The progress bar records completed stages: document parsed, lobby ready, first game frame rendered. It does not claim to measure downloaded bytes.

The entry has no static application or stylesheet imports. Vite loads lobby JS/CSS through a dynamic import, and the lobby paints before requesting Three.js and game code. The loading screen fades for 180 ms into the functional lobby; class selection, room creation/joining, settings and invites are available while the game chunk downloads. Ready/Join Match and the host's Start Early control wait for a successful first frame. A late join still follows the authoritative round phase when rendering becomes ready. Network transport, prediction, movement, server simulation and load thresholds are unchanged.

The reported 2.2 MB physics payload is absent from this revision and the inspected live entry. On September 6, the live HTML at `https://krunker1-production.up.railway.app` referenced `index-wKSYu9_8.js`, a 611,305-byte bundle, matching the pre-change local build. It had no `Content-Encoding` even when requesting `br, gzip`. It already had `Cache-Control: public, max-age=31536000, immutable`. `npm ls @dimforge/rapier3d-compat` resolves Rapier only through the development package `@types/three`; it is absent from Vite's runtime graph. This game uses shared TypeScript movement/collision, so no asynchronous physics initializer or WASM dependency was added. The expensive runtime dependency deferred here is Three.js.

| File/stage | Uncompressed bytes | Brotli bytes | Gzip bytes |
|---|---:|---:|---:|
| Initial HTML, including screen and failure guard | 6,276 | 1,840 | 2,382 |
| Entry JS | 2,101 | 932 | 1,077 |
| Lobby JS | 63,931 | 20,169 | 22,696 |
| Lobby CSS | 37,832 | 7,975 | 8,909 |
| Game/scene JS, deferred | 33,214 | 11,304 | 12,785 |
| Three.js, deferred | 514,288 | 106,126 | 127,923 |
| Optional font; system fallback paints first | 19,072 | 8,545 | 9,320 |

The first screen needs only the HTML response. Lobby startup needs about 29 kB of Brotli JS/CSS, plus that HTML; font delivery does not block it. Total JS transferred with Brotli is 138,531 bytes, versus the previously uncompressed 611,305 bytes (77% less). These are build/HTTP measurements, not browser timings. Exact filenames and sizes are in [payloads-and-timing.json](payloads-and-timing.json).

`scripts/compress-client.mjs` generates `.br` and `.gz` files during the build, including WASM when present. The server negotiates precompressed files, emits `Vary: Accept-Encoding`, preserves the original MIME type (`application/wasm` for WASM), and adds Content-Length and ETags. Hashed assets retain one-year immutable caching; HTML revalidates. Compression consumes no game-loop CPU. Tests verify decoded bytes against the originals, both encodings, q=0, encoding preference, conditional 304s, HEAD requests, missing chunks and path rejection. WASM coverage uses a fixture because this application ships no WASM.

Browser measurements, using the requested cold-cache navigation and sampling every 500 ms:

| Build | First visible content | Lobby usable |
|---|---:|---:|
| Live baseline, supplied by the user | 8,710 ms | Not supplied |
| Updated build | Awaiting calling agent | Awaiting calling agent |

The updated production server is available at `http://localhost:8089`. The calling agent was asked to measure the cold-cache page, then check an invite with Three.js delayed and with WebGL disabled. After applying/pushing the patch, repeat against the deployed origin. For the same sampling method, start timing before navigation, sample the rendered viewport every 500 ms, and record the first sample with visible content. Also record when class/room controls are usable; `performance.getEntriesByName('furo-lobby-ready')` and `furo-game-ready` help correlate stages but do not replace the viewport samples. Check failed entry JS, failed lobby CSS, failed game chunk and reload preserving `?room=`. A returning-player pass should show cached hashed assets. No after-browser number is inferred from jsdom, HTTP timing or build sizes.

Verification: `npm test` passes 154/154, including initial HTML without JavaScript, production bundle dependency separation, delayed game initialization, class selection during loading, first-frame readiness gating, all startup error paths, and asset delivery. Build/typecheck, integration, lobby, lobby flow, soak, lifecycle and production smoke checks pass. The production check exercises both actual HTTP compression/caching and two clients navigating, killing and respawning through the server.

The production smoke fixture initially failed to navigate: its z=34 waypoint crossed the solid lamp at (28,34), already present in the base revision. The diagnostic captured Alpha stopped at x=27.545, z=34.455 with input acknowledgements still advancing; [the captured failure](production-route-before.log) is retained. The fixture now uses the clear outer lane at z=±36. Navigation timeout, headshot/kill, replication, respawn and server tick assertions are unchanged. No collision or simulation code was changed to make this pass.

Both final load matrices pass the unchanged acceptance thresholds. Each uses the built server at `http://127.0.0.1:8091`, Node 25.9.0, seven bots, and 30 seconds per stage. Added latency is one-way in both directions. No build or other verification suite ran concurrently with the matrices.

| Added latency | Humans | Tick Hz | Max sampled-window tick p95 | Worst client snapshot p99 | Desyncs / replica errors | Prediction p99 |
|---|---:|---:|---:|---:|---:|---:|
| 0 ms | 2 | 60.02 | 12.242 ms | 54 ms | 0 / 0 | 0 m |
| 0 ms | 5 | 60.00 | 4.673 ms | 53 ms | 0 / 0 | 0 m |
| 0 ms | 10 | 59.97 | 7.758 ms | 54 ms | 0 / 0 | 0 m |
| 80 ms | 2 | 59.31 | 6.005 ms | 56 ms | 0 / 0 | 0 m |
| 80 ms | 5 | 60.01 | 5.873 ms | 58 ms | 0 / 0 | 0 m |
| 80 ms | 10 | 60.01 | 6.251 ms | 56 ms | 0 / 0 | 0 m |

Raw reports: [0 ms](load-local-0.json), [80 ms](load-local-80.json). The [initial 0 ms attempt](load-local-0-first.json) failed the tick-processing threshold at five humans: max sampled-window tick p95 18.555 ms, peak 85.386 ms, four over-budget ticks, with zero desyncs/replica errors and zero prediction p99 error. A complete repeat on a fresh server passed without implementation or threshold changes. The cause of the timing spike is not established; timing variability is retained rather than discarded. These local results do not replace a public-deployment load recheck after the calling agent applies and deploys the patch.

The complete patch is `/tmp/furo-startup.patch`, against the base revision above. Git metadata is read-only in this workspace; the calling agent can apply and push the patch. The browser measurement remains outstanding and is explicitly null in the machine-readable timing report.
