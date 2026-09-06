# Multi-map completion evidence

Base revision: `dec41d6328e29d41148ae6380ba915bec01d10bf`.
The supplied checkout already contained the five-map implementation and the
corrected reload fixture. Its initial 353 tests passed. This continuation keeps
those layouts and lobby behavior, fixes map selection in the standalone load
client, makes fixed-coordinate probes select their fixture map, and strengthens
room-isolation and lifecycle coverage.

## Reload diagnosis

The reported `30 !== 1` is reproducible when the fixture assigns the `results`
phase but leaves `round.nextAt = 0`. At `tick(1000)` that deadline has expired:
the room enters its next lobby, prepares the map and spawns a new life. The rifle
magazine is correctly restored from 1 to 30; no shot or reload occurs. The life
counter changes from 2 to 3, even on fixed Sandyard, ruling out spawn selection
or a random-map ammunition difference.

With `nextAt = 10000`, the room remains in results, life remains 2, ammunition
remains 1, and reloadEnd remains 0. The supplied checkout already contained this
fixture correction. This continuation changes no existing reload expectation;
it adds a comment and tests both sides of the results deadline on all five maps.

## Candidate identity

Concurrent ability/grenade changes appeared in the shared checkout during this
task. They were preserved. Reproducible map-only verification uses the base plus
this continuation's changes in `/tmp/krunker-map-candidate`. All five benchmark
bundles are byte-for-byte identical to the Railway upload. `candidate.json`
records source hashes; `railway-launch.json` and `railway-status.json` record
bundle hashes. These results do not claim to validate subsequent concurrent edits.

## Local verification

- `unit-tests.txt`: all 364 tests pass.
- `build.txt`: TypeScript, Vite production build and server bundle pass.
- `maps-tests.txt`: all 65 map tests pass, including interleaved room physics,
  bot perception/navigation, prediction/replay, health, lifecycle and live lobby isolation.
- `../bounds-audit.txt`: zero mismatches on all five maps, with a 0.0001 m bounds
  tolerance, exact shell-band coverage, negative gap tests and production batching checks.
- Collision regression: 40,200 solid-face approaches at 28 m/s across five
  angles, air/slide/hop modes and two tick sizes; 278,400 assembled-map movement
  steps; every ramp checked for climbing, side/end entry and fast falls; every
  solid top/underside checked at 400 m/s vertical speed.
- `integration.txt`: actual WebSocket movement, weapons, rewind, respawn,
  round transitions and reconnect checks pass.
- `production.txt`: built assets, compression/caching and two-client navigation
  to a confirmed headshot kill pass.

## Railway verification

The isolated candidate runs inside Railway over loopback. The live application
is unchanged. The matrix uses all five maps, 2/5/10 simulated humans plus seven
bots, 30 seconds per case, and 0/80 ms added one-way application delay. Bad-link,
aimed-shot and remote-interpolation regressions follow. Collection is in progress;
the JSON reports distinguish partial results from completed checks.

## Previews

`../index.html` links three generated PNGs per map: overview, spawn and landmark.
`../contact-sheet.png` shows all 15 together; `../manifest.json` records cameras.
The repository's software renderer generated these from the production geometry
without launching a browser or connecting to CDP. Lighting is approximate, with
WebGL shadows and canvas signs omitted.
