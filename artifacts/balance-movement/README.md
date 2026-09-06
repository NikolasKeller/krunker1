Implemented against exact base `9a53999c5f6780c063a4769789cb3f729b6e8e07`.
That revision already includes the common 100 HP cap and the critical pass's
increased weapon damage. All comparisons below use that actual base at **100 HP**.
These are reproducible headless measurements, not browser playtesting.

Friendly fire is resolved after ray tracing and lag compensation. Every living,
connected target, including a teammate, retains its hitbox on the shot's timeline.
The server filters resolved damage using **current teams at validation time**.
A teammate absorbs the pellet without damage, hit events, hit sounds, health
changes or scoring. Client prediction applies the same rule and still shows the
shot/impact. Current team metadata bypasses remote position playback. FFA is
unchanged. Tests exercise humans, bots, queued shots and mid-round switches in
both directions, obsolete historical teams, genuine rewound enemies, a teammate
blocking an enemy behind, and the absence of predicted feedback.

The shotgun changes from **40 to 52 damage per pellet**, with eight pellets,
full damage through **5 m instead of 7 m**, quadratic falloff and a **22 m range
instead of 32 m**. Spread, head/leg multipliers, the 800 ms interval, two-shell
magazine and 1,550 ms reload stay unchanged. Two close body pellets now deal
104 instead of 80 damage; the full close body blast rises from 320 to 416.
The current base already kills a perfectly centred point-blank target in one
shot, so its ideal point-blank TTK cannot decrease. The increase makes partial
close hits more forgiving while reducing medium/long-range effectiveness.

Measured shotgun TTK below starts at the first shot. Each cell uses 300 seeded
trials, a stationary 100 HP target, hip fire centred on the torso, production
pellet rays/hitboxes/recoil, and actual command cadence and reload timing.
Speed is held constant for the spread calculation; the moving-shooter column
tests maximum-speed spread, not a changing engagement distance. All in-range
trials finish within the 120-second limit; no failed trials are excluded.

| Range | Mean first blast damage, stationary: before → after | Mean TTK, stationary: before → after | Mean TTK at 28 m/s spread: before → after |
| --- | --- | --- | --- |
| Point blank, 2 m | 320 → 416 | 0 → 0 ms (one shot) | 0 → 0 ms |
| Close, 5 m | 325.1 → 422.6 | 0 → 0 ms | 0 → 0 ms |
| Close edge, 8 m | 250.9 → 244.6 | 0 → 0 ms | 64 → 64 ms |
| Medium, 12 m | 106.8 → 76.0 | 385.8 → 782.7 ms | 1,065.8 → 1,743.3 ms |
| Long, 25 m | 3.8 → 0 | 32.18 s → cannot kill | 56.80 s → cannot kill |
| Beyond both ranges, 33 m | 0 → 0 | cannot kill → cannot kill | cannot kill → cannot kill |

At 12 m the stationary one-shot rate falls from 55% to 18%; at maximum-speed
spread it falls from 16.7% to 3.3%. At 2 m it remains 100% in both conditions.
Aggregate blast damage is uncapped and can include head/leg pellets, explaining
why a 5 m blast can slightly exceed the all-body value. [Raw before](before.json)
and [raw after](after.json) also include a damage/shot-count table for all weapons.

The other weapons are unchanged. Their ideal body-hit timings at close range,
using 60 Hz command cadence and excluding the first shot's aiming/reaction delay:

| Weapon | Applied body damage | Hits to kill | TTK at 100 HP | Assessment |
| --- | --- | --- | --- | --- |
| Sniper | 184 | 1 | 0 ms | Main balance concern: even legs deal 101 through 120 m, so precision is unnecessary for a one-hit kill. |
| Rifle | 42 | 3 | 266.7 ms | Reliable general-purpose weapon with better range/precision than SMG. |
| SMG | 30 | 4 | 250 ms | Only 16.7 ms faster in ideal body TTK, but has faster movement and a larger magazine; limited advantage rather than clearly useless. |
| Pistol | 40 | 3 | 500 ms | Appropriately weaker backup. |
| Knife | 55 | 2 | 450 ms | Weak as a damage choice: a ranged rifle kills faster despite melee's risk. Its speed bonus still provides utility. |

Concrete proposals for a separate decision: reduce the sniper leg multiplier
from **0.55 to 0.45** (101 → 83 close leg damage, two leg hits), preserving body
and head damage. If SMG needs a stronger close-range niche, **30 → 34 damage**
would give three close body hits in 166.7 ms, with its current falloff intact.
For knife combat, apply **100 flat melee damage within 2.8 m** and bypass ranged
falloff. Its present `falloff=3` exceeds `range=2.8`, so the generic formula
halves its nominal 109 damage everywhere it can reach. These numbers are
proposals, not additional balance changes made here.

Normal bots receive a small combined adjustment, led by reaction delay:

| Normal setting | Before | After |
| --- | --- | --- |
| Reaction after acquisition/reacquisition | 340 ms | 420 ms |
| Yaw error amplitude | 0.042 rad | 0.044 rad |
| Pitch error amplitude | ±0.021 rad | ±0.022 rad |
| Per-tick yaw/pitch convergence | 0.16 / 0.15 | 0.15 / 0.14 |
| Standing aim height | 1.10 m | 1.05 m |
| Forward push beyond preferred range | 0.65 | 0.62 |

Navigation speed, strafe strength and preferred ranges stay unchanged. Easy and
Hard keep their existing tuning. All difficulties now pursue only visible or
last-observed positions, remembering a lost sighting for at most two seconds.
Previously navigation selected the nearest enemy even through solid cover.
They still stop firing immediately when sight is lost, reacquire with a full
reaction delay, and forget acquisition/memory on respawn. Sliding targets use
their actual shorter body height for aiming. The cover behavior is checked
separately by tests proving unseen target movement cannot change aim or paths.

Bot results: **300 paired seeded rifle duels per difficulty and target condition**,
starting 18 m apart in an open arena. The bot runs its real server perception,
navigation, aiming, movement, firing, damage, recoil, spread and reload code.
The target is stationary or strafes ±4 m at 6 m/s. Accuracy is damaging shots /
shots fired; TTK starts when the target becomes exposed, so it includes reaction.
All 1,800 duels per revision finish within 20 seconds. This isolates difficulty
from the shotgun change and does not claim match-wide or all-weapon bot accuracy.

| Difficulty | Stationary accuracy: before → after | Stationary mean TTK: before → after | Moving accuracy: before → after | Moving mean TTK: before → after |
| --- | --- | --- | --- | --- |
| Easy | 35.42% → 35.42% | 1,427.2 → 1,427.2 ms | 31.51% → 31.51% | 1,523.9 → 1,523.9 ms |
| Normal | 45.72% → 44.24% | 1,022.7 → 1,153.6 ms | 36.80% → 36.08% | 1,216.4 → 1,336.7 ms |
| Hard | 46.62% → 46.62% | 932.7 → 932.7 ms | 43.48% → 43.48% | 982.4 → 982.4 ms |

Normal encounter TTK increases **12.8% stationary / 9.9% moving**. Its measured
first shot moves from 366.7 to 450 ms; Easy stays at 550 ms and Hard at 250 ms.
Normal's headshots as a fraction of hits fall **19.21% → 13.57% stationary** and
**18.30% → 12.56% moving**. Easy remains 21.58% / 23.69%, Hard 7.36% / 9.80%.
The lower difficulties' wider errors occasionally hit heads accidentally; Hard
lands torso hits much more consistently. The report also preserves TTK measured
from the first shot rather than exposure.

Two independent collision faults reproduce without networking:

* At `(-14, 0, -3.881)`, entering the ramp side with `vz=28` snaps feet **0.552 m
  upward**. Starting airborne at Y=0.35 with `vy=1` adds 0.202 m and cancels the
  jump's velocity. The old floor resolver accepted any ramp within 0.65 m above
  the previous feet. Afterward, a side entry stays at Y=0; the airborne case
  rises only 0.010 m from its existing velocity and gravity.
* A small box step raises the feet, but the vertical pass uses the pre-step Y,
  fails to retain support, and gravity buries them in the box. The following
  substep can eject the other axis. The real-coordinate roof fixture moves
  X from **−19 to −11.62 (7.38 m)** despite zero X velocity. Afterward it retains
  support. The 0.3 m step fixture advances normally and ends exactly at Y=0.3,
  instead of falling to 0.2933 and being ejected back to the entry face.

The shared client/server resolver now keeps step support within each substep,
budgets box step height across the whole command, and raises feet on ramps only
for grounded travel along their slope by the height of that actual travel.
Airborne ramp contact never manufactures a landing above the existing feet.
It does not convert horizontal collision velocity into upward velocity.

The sweep exercises **7,200 cases / 131,184 ticks**: every actual collider's faces
and corners at its original coordinates, tangent rounding offsets, assembled
box contacts, every ramp edge and platform junction, running/sliding/hopping,
and elevated airborne approaches. The existing thin-wall/long-step and
prediction/replay collision tests remain in the suite. [Before](edges-before.json)
has **352 invalid displacements**; [after](edges-after.json) has **zero**.
There are zero positive-velocity injection violations in either version: the
reproduced upward fault injects **position/height**, not a positive `vy` impulse.
This distinction explains why a velocity-only assertion would have missed it.

Network movement was investigated separately. All twelve 120-second impaired-link
replays at 60/144 Hz retain **zero local correction, zero snapshot camera jumps
and zero dropped inputs**, before and after. [Before](local-before.json),
[after](local-after.json). No regression in local correction was found.

The WebSocket transport is unchanged. The prior link capture's association of
out-of-order delivery with 83.7% of stalls over 100 ms remains evidence of TCP
head-of-line blocking; it is not a percentage of jitter time explained by loss.
Collision fixes remove the reproduced snaps/ejections, while TCP delivery stalls
and very long playback underruns can still make motion rough. See the original
[transport evidence](../transport/README.md).

All **289/289 unit tests**, typecheck, production build and real HTTP/WebSocket
integration pass. [Test output](tests.txt), [build](build.txt),
[typecheck](typecheck.txt), [integration](integration.txt).
The final source also passes the controlled remote playback regression:
maximum frame displacement at 60 Hz is **0.090 m stable, 0.091 m matched-quantile,
0.090 m one-second stalls, and 0.133 m four-second blackout**, below 0.15 m in
every case. All 16 combinations including 144 Hz and omitted snapshots retain
the existing frame-scaled bounds. [Remote replay](remote-after.json).
Live WebSocket callback spacing is variable; its raw displacement metric also
includes ordinary travel between callbacks and is not the fixed-60-Hz jump
measurement. The 350 ms run's largest recovery displacement is 0.0141 m.

The final two live HTTP/WebSocket combat runs register **480/480 aimed hits**,
with zero prediction disagreements, rejected shots, resyncs, local corrections
or snapshot camera jumps. The 350 ms profile measures RTT p50/p95/max of
356/615/622 ms; the one-second-stall profile measures 356/1,179/2,178 ms.
Requested and actual rewind timestamps match exactly in both. Maximum target
pose difference is 0.00474 m and 0.06222 m respectively. The latter run includes
four brief interpolation underruns but zero exhausted-runway episodes; its
largest recovery displacement is 0.0276 m. The one-second profile's delivery
gaps still reach 2.007 s, directly demonstrating that the transport stalls remain.
Provisional feedback completes within 5.02 ms / 4.04 ms respectively and weapon
switch feedback within 4 ms / 11 ms, preserving the existing frame-time checks.
[350 ms session](combat-350.json), [one-second stalls](combat-one-second.json).

Both required **inside-Railway** load matrices pass on Node v22.23.2, with an
isolated candidate listener, 30 seconds per row and seven bots. They retain
**zero desyncs, replica errors and dropped inputs**, and zero prediction p99.
The deployed service is unchanged; these are Railway runtime/loopback results,
not a new measurement of the player's workstation-to-public-edge route.

| Added each-way delay | Humans + bots | Tick Hz | Mean tick ms | Highest window tick p95 ms | Worst snapshot p99 ms |
| --- | --- | --- | --- | --- | --- |
| 0 ms | 2 + 7 | 60.03 | 0.489 | 1.365 | 52 |
| 0 ms | 5 + 7 | 59.99 | 0.611 | 1.760 | 52 |
| 0 ms | 10 + 7 | 59.98 | 0.914 | 2.983 | 53 |
| 80 ms | 2 + 7 | 59.99 | 0.417 | 1.149 | 53 |
| 80 ms | 5 + 7 | 59.99 | 0.576 | 1.565 | 53 |
| 80 ms | 10 + 7 | 60.00 | 0.920 | 4.025 | 54 |

[Railway 0 ms](railway-load-0.json), [Railway 80 ms](railway-load-80.json),
[candidate bundle hashes and probe exit codes](railway-status.json).
The independent two-minute Railway impaired-link movement probe also retains
zero local correction, camera jumps and dropped inputs, with measured RTT
p50/p95/max of 355/1,601/4,212 ms. [Railway movement](railway-bad-link.json).
All five Railway probes finish successfully. The separate Railway hitscan
probe registers **72/72 hits** across 0/100/350 ms RTT with zero correction or
resyncs, and all 16 remote playback cases retain the frame-scaled 0.15 m bound.
[Railway hitscan](railway-hitscan.json), [Railway remote replay](railway-remote.json).
No browser or CDP connection was used. No production deployment was performed.

The first live 240-shot combat run exposed an inherited measurement-fixture
failure: 238 rifle body hits leave only four of the fixture's 10,000 HP, and hit
239 kills it before the designated final shot. The final shot therefore had no
living target to rewind. [Preserved failure](combat-350-fixture-failure.json).
The combat probe now derives fixture health from the shot count and maximum
rifle hit damage, asserts that it survives until the final resolution, and
records pre-shot health. No hit-rate, disagreement or timing assertion is relaxed.

Reproduce from this working tree:

```sh
BALANCE_REPORT=artifacts/balance-movement/after.json npx tsx tests/balance-report.ts
EDGE_REPORT=artifacts/balance-movement/edges-after.json npx tsx tests/movement-edge-report.ts
BAD_LINK_REPORT=artifacts/balance-movement/local-after.json npm test
npm run build
HIT_RTTS=350 HIT_SAMPLES=240 HIT_INTERVAL_MS=140 COMBAT_REPORT=artifacts/balance-movement/combat-350.json npm run test:combat:ws
HIT_RTTS=350 HIT_SAMPLES=240 HIT_INTERVAL_MS=140 HIT_LINK_PROFILE=one-second-stalls HIT_WARMUP_MS=30000 COMBAT_REPORT=artifacts/balance-movement/combat-one-second.json npm run test:combat:ws
python3 tests/railway-fairness.py --output artifacts/balance-movement
python3 tests/railway-fairness.py --output artifacts/balance-movement --collect
```

Baseline reproduction: `git archive` the exact base into a separate directory,
install/link dependencies, and copy only `tests/balance-report.ts`,
`tests/movement-edge-session.ts`, and `tests/movement-edge-report.ts` into it.
Run the same report commands there with different output destinations, plus
the unchanged `tests/bad-link.test.ts`. No baseline gameplay source is patched.

The workspace `.git` is read-only. The source, tests and measurement patch is
`/tmp/krunker-balance-movement-9a53999.patch`, based on exact revision
`9a53999c5f6780c063a4769789cb3f729b6e8e07`. These working files already contain
the changes; apply the patch only to a clean checkout of that base.
[Verification inventory](verification.json) records the candidate source hashes.
