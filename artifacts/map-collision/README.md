The base revision is `a82f92e976f74fee6de9da79b088d5cd8688cafd`.

Two reproducible faults were found: visible geometry extended beyond collision,
and ordinary walking at real map coordinates could trigger a sideways collision
ejection. Client and server both reproduced the latter. No browser was launched.

The requested headless geometry audit measured the actual Three.js meshes,
including rotated braces, cylinders, signs and all architectural attachments.
[Every original object and its numerical offsets](bounds-before.txt) and
[complete building bounds including their roof/vent colliders](buildings-before.txt)
are recorded. The 23 failing object groups were:

| Object IDs | Original excess beyond owning collider, metres |
| --- | --- |
| Boundary walls 0, 1, 2, 3 | 0.04 toward the yard |
| Buildings 4, 5, 6 | ±X 0.21, ±Z 0.38; roof louvers 0.935 above main wall box |
| Building 7 | −X 0.21, +X 3.5, −Z 2.06, +Z 0.38; louvers 0.935 above main wall box |
| Building 15 | ±X and ±Z 0.025 |
| Platforms 8, 9 | +Y 0.03 |
| Large crates 16, 18 | ±X 0.02, ±Z 0.13 |
| Small crates 17, 19, 24, 25 | ±Z 0.11 |
| Containers 20, 21 | ±X 0.05, ±Z 0.08, +Y 0.06 |
| Vans 22, 23 | −X 0.05, ±Z 0.0225 |
| Both fences | +Y 2.0 above boundary-wall collision |

Roof vents already had body/cap colliders: their louvers exceeded the cap by
0.025 m, rather than leaving the entire 0.935 m unsupported. Roof slabs also
had their own matching colliders, but all five overhung the supporting building
footprint by 0.175 m on every side. The separate footprint check catches that
case even when the combined building/collider bounds match. The misplaced
“A →” sign was outside its building entirely. Wall flags on the shorter buildings
also extended 0.25 m above the wall and were lowered.

The fix reserves room for facade/prop details inside the original footprints,
keeps roof edges inside the supporting building footprint, seats vent louvers
on their caps, anchors signs to their actual facade, and adds two shared fence
panel colliders. The 12 lamp components and three ramp wedges already matched.
The crane and all 16 skyline buildings remain beyond the playable boundary;
the audit rejects any move into the arena. Ground paint and thin overhead cloth
pennants are explicitly non-solid and constrained by their measured geometry.

The movement counterexample was reproduced from an untouched `git archive` of
the base revision, using that revision's movement, map, math and input codec.
Start at `moveState(-28.38, 0, -13)` and hold forward with packet yaw
`Math.fround(-Math.PI / 2)`, without jumping or sliding. At tick 15:

| | X | Y | Z |
| --- | --- | --- | --- |
| Before | −26.530796638407537 | 0 | −12.999999919168754 |
| Original result | −26.38 | 0 | −5.62 |
| Fixed result | −26.38 | 0 | −12.999999911300705 |

The original X projection put the player on the contact plane. Subtracting the
building centre produced `7.379999999999999`, less than the nominal contact
distance `7.38`. The Z pass then treated that rounded contact as penetration
and pushed the player 7.38 m sideways to another wall face. A test that only
checks final non-overlap, or translates colliders to simpler coordinates,
misses this failure. The fix applies the existing `1e-9` vertical contact
tolerance to horizontal overlap as well. See the exact [before](walking-before.jsonl)
and [after](walking-after.jsonl) input/state traces.

The client `predictInput()` and server `Room.tick()` both call the same shared
`move()` resolver. Their life/alive/round guards and class/knife speed scales
agree. Reconciliation uses `predictInput()`; render previews and corrections
also use shared swept collision clipping. A deterministic 120-input packet
recording was replayed against every building face for all four classes, with
slot and ADS changes: 9,600 positions and all movement fields matched exactly,
including full pending-input replay. Every approach reached its wall and stayed
on that side. This is a local reproducible recording, not deployed-player telemetry.

Permanent checks are included in `npm test`:

- `map-geometry.test.ts` audits all 77 object groups against 53 shared solids
  and the ramp wedges at 0.0001 m tolerance. It verifies ownership of every mesh,
  rejects unsupported roofs, and proves production batching preserves every
  triangle and textured sign. It also checks that signs remain visible.
- `map-prediction.test.ts` runs the packet recording through actual prediction,
  server enqueue/tick, and reconciliation.
- `collision.test.ts` includes the exact building ejection and crate contact
  regressions. The existing speed test's start moved from X=32 to X=34 because
  its old path ran directly into a crate and relied on the sideways ejection
  to keep running; a separate assertion now requires that old path to stop.

Validation: all 161 tests pass; `npm run build` passes. The static map remains
7 draws / 15,958 triangles, and the existing tracer, opponent, collision,
underpass, protocol and stall tests pass. `npm run audit:map` prints the complete
numerical inventory and exits nonzero on any mismatch. Its [final output](bounds-after.txt)
reports zero mismatches. Twenty-micrometre surface offsets keep paint/louvers
visible without meaningful protrusion. Deployment and browser playtesting are
not claimed by these headless checks.
