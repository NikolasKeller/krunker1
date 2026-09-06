# Fairness and immediate player selection — 2026-09-06

Base revision: `5c3d7d0ebe1c16bd307ddaa8e5d1caa354462340`.

## Causes and changes

- Every spawn excluded the target from hitscan for 1.5 seconds. Reconnecting or taking over an active session called spawn again, granting full health and another immunity window. Immunity has been removed from authoritative hitscan, shared predicted target eligibility and rendering. The old `protectionEnd` wire field remains zero for protocol compatibility. Reconnects resume the same actor, health, position, inventory and death deadline; the superseded socket cannot disconnect its replacement. Disconnected players remain in round results but are excluded from hitscan and bot targets.
- Rewind could return a dead or obsolete life and remove the living target altogether. This was especially visible because the client immediately draws a new life even while interpolation playback still predates that life. Such targets now use their current hitbox; their old pose cannot transfer damage to the new life. Normal same-life rewind is unchanged. Both failures reproduce against the exact base revision in [before.txt](before.txt).
- Live team changes were rejected and live class changes silently stored in `pendingClass`. That queued class could overwrite a newer lobby selection when `spawn()` ran. The queue is gone. Class changes equip the new primary immediately without moving the player. Team changes relocate to that team's spawn and preserve the equipped loadout. Both preserve health, death deadlines, inventory and existing fire cooldowns. Repeating a selection is a no-op. Dead players remain dead until their existing respawn deadline. Host moves of other players remain a lobby action; live self-switches are allowed, with clear interface text. Results lock the controls.
- Selection requests have an increasing request ID, acknowledged together with authoritative snapshot state. Pending presentation changes own only selection/loadout fields, so old or intermediate snapshots cannot overwrite a later class/team choice or hide incoming damage/death. Class and team remain independent requests. HUD, class card, team colour, lineup and scoreboard use the same presented selection. The input life generation rejects queued old controls after a selection; the viewmodel and control slot follow the resulting weapon. Class firing waits for the authoritative selection, then the normal draw/cooldown checks. Ammo prediction retains the inventory across selection generations.

Every class now starts and caps at **100 HP**. The chosen balance baseline is the former **60-HP Hunter**: a single health pool cannot preserve both old target kill times. Other formerly 100-HP classes are consequently faster to kill. Damage scales by 100/60 (rounded up); firing interval, spread, falloff, recoil, reload and magazines remain unchanged.

## Weapon timings

Body hits within full-damage range, all pellets hitting for the shotgun, measured from the first damaging shot to the lethal shot. Knife is sampled at 2 m; the others at 5 m. A zero means a one-shot kill, excluding aiming, draw, input latency and travel to melee range. There are no reloads in these scenarios.

| Weapon | Base damage before → after | Old 60 HP TTK | Old 100 HP TTK | New 100 HP TTK |
| --- | ---: | ---: | ---: | ---: |
| Sniper | 110 → 184 | 0 ms | 0 ms | 0 ms |
| Rifle | 25 → 42 | 240 ms | 360 ms | 240 ms |
| Shotgun, per pellet | 24 → 40 | 0 ms | 0 ms | 0 ms |
| SMG | 18 → 30 | 216 ms | 360 ms | 216 ms |
| Pistol | 24 → 40 | 480 ms | 960 ms | 480 ms |
| Knife | 65 → 109 | 450 ms | 1,350 ms | 450 ms |

The existing knife falloff formula reaches its 0.5 floor throughout melee range (`falloff=3`, `range=2.8`), so its **applied** damage is 33 → 55, not its nominal base statistic. Its actual two-hit Hunter kill remains a two-hit 100-HP kill. This report uses that actual behavior rather than assuming a one-hit knife.

The production command clock rounds intervals up to 60 Hz steps. Actual first-hit-to-kill times for modern clients are:

| Weapon | Old 60 HP | Old 100 HP | New 100 HP |
| --- | ---: | ---: | ---: |
| Sniper | 0 ms | 0 ms | 0 ms |
| Rifle | 266.67 ms | 400 ms | 266.67 ms |
| Shotgun | 0 ms | 0 ms | 0 ms |
| SMG | 250 ms | 416.67 ms | 250 ms |
| Pistol | 500 ms | 1,000 ms | 500 ms |
| Knife | 450 ms | 1,350 ms | 450 ms |

[weapon-balance.json](weapon-balance.json) includes shot counts, effective damage and head/body/leg cases. Close-range sniper leg damage rises from 61 to 101: it now kills all classes in one hit, as it previously did Hunters. Damage rounding and falloff can change thresholds at other distances; the tables state their conditions and do not claim every range/zone is identical.

## Regression coverage

[fairness.test.ts](../../tests/fairness.test.ts) reproduces fresh-spawn immunity and lost hitboxes across life changes, checks that obsolete poses cannot damage a new life elsewhere, and checks that class/team cycling cannot heal, refill ammo, shorten death or reset a fire cooldown.

[fairness-lifecycle.test.ts](../../tests/fairness-lifecycle.test.ts) drives real Node WebSockets through join → ready → countdown → play → damage → death → respawn → class → team → results/rematch → reconnect → live token takeover → late join → room switch/rejoin. Aimed shots use the production damage path and reduce authoritative health after every living step; both local authority and predicted health must reconcile downward. Dead steps assert zero health and no premature revival. The lobby checks exercise target damageability directly; ordinary firing remains gated to a running round.

[selection.test.ts](../../tests/selection.test.ts) tests team, class, both orders and repeated classes in lobby/live play. It replays old, intermediate and accepted binary snapshots while checking the actual DOM and Three.js viewmodel scene graph, alongside real WebSocket request-handler tests. Health/death still reconcile while a class prediction is pending.

No browser launch or CDP connection was attempted. DOM, scene-graph and render-input tests do not claim a human browser/GPU playtest.

## Validation

`npm test`: **268/268 pass**. `npm run build` (including TypeScript checking), `npm run test:integration` and `npm run test:lobby` pass. [Suite output](tests.txt), [build](build.txt), [combat integration](integration.txt), [lobby integration](lobby.txt), [selection checks](selection.txt).

All 12 deterministic bad-link scenarios report **0 m** raw movement correction, **0 m** snapshot camera jumps and **0 dropped inputs**. [Report](bad-link.json). The existing remote motion tests pass their **0.15 m/frame** bound at 60 Hz and proportional bound at 144 Hz. Railway verification uses an isolated loopback candidate server inside the existing Railway container. It does not deploy or modify the public server. Bundle SHA-256 hashes in `railway-launch.json` and `railway-status.json` identify the precise server and client harness code; the base commit alone is not claimed as the candidate revision.


Railway Node **22.23.2**, 30 seconds measured per row, seven bots, final server bundle `06616b209188bb80e33dbad10bb90b6a6899b450b21eb3c9b09a6aee41a47a05`:

| Added latency each way | Humans | Tick Hz | Mean tick ms | Worst window p95 ms | Client snapshot p99 ms | Desyncs / replica errors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 ms | 2 | 60.03 | 0.507 | 2.227 | 53 | 0 / 0 |
| 0 ms | 5 | 59.99 | 0.580 | 2.452 | 54 | 0 / 0 |
| 0 ms | 10 | 59.99 | 0.937 | 4.478 | 56 | 0 / 0 |
| 80 ms | 2 | 60.03 | 0.423 | 1.485 | 54 | 0 / 0 |
| 80 ms | 5 | 59.98 | 0.548 | 1.711 | 53 | 0 / 0 |
| 80 ms | 10 | 60.00 | 0.848 | 2.331 | 53 | 0 / 0 |

Prediction p99 is **0 m** for every client in all six rows. All existing matrix assertions pass. [0 ms matrix](railway-load-0.json), [80 ms matrix](railway-load-80.json).

The two-minute real WebSocket bad-link session inside Railway also passed: **0 m** raw correction, snapshot jump, backward correction and deviation from the unimpaired movement path; **0** dropped inputs, sequence gaps or frozen outage frames; final server path error **0 m**. Measured probe RTT p50/p95/p99/max: **355 / 1,602 / 2,959 / 4,211 ms**. [WebSocket report](railway-bad-link.json).

The first bundled hitscan probe failed at startup with `EADDRINUSE:8080`: the bundled imported server incorrectly recognized the probe as its CLI entry point. The runner now overrides `import.meta.url` only for that library test bundle, preventing the extra CLI listener. The candidate server/game code did not change. Successful load and bad-link runs are retained only after verifying their hashes; the remaining probes can be resumed with `python3 tests/railway-fairness.py --resume-probes`. [Initial runner failure](railway-hitscan-first-failure.txt).

The corrected aimed-shot WebSocket probe passed **72/72 shots**: 24/24 at each of **0, 100 and 350 ms RTT**, with zero resyncs, zero movement correction and zero snapshot jumps. [Shot-level report](railway-hitscan.json). All 16 deterministic remote-motion replays also completed inside Railway; maximum frame displacement **0.13312 m**, below **0.15 m** at 60 Hz, with the proportional bound respected at 144 Hz. [Remote motion report](railway-remote.json).

[Final Railway status](railway-status.json) records success for every check. The candidate test server closes after the probes; the public deployment is unchanged.

## Patch handoff

The workspace’s `.git` is read-only. The complete patch is `/tmp/krunker-fairness-5c3d7d0.patch`, against exact base `5c3d7d0ebe1c16bd307ddaa8e5d1caa354462340`. It applies to a clean checkout of that revision; this workspace already contains the changes. Public deployment has not been changed. Client and server should be released together.
