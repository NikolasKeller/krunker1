# Class abilities and shared grenade

Q activates the current class's ability. G throws a grenade. The mobile layout has dedicated buttons above the left-side health panel, with the same names, states and timers as the desktop HUD. Furo's charcoal plates, condensed headings and lime accents distinguish READY, ACTIVE (seconds remaining), cooldown, respawning and round-ended states. Loadout text explains each power.

| Class / ability | Effect | Cooldown from activation | Why this interval / counterplay |
| --- | --- | --- | --- |
| Hunter / Watchpoint | A 10-second lookout anchored at activation. After 0.8 seconds, aiming reveals last-seen markers every 0.5 seconds for enemies within 60 m, inside the forward 120° cone and in unobstructed sightlines. Only the Hunter receives the markers; each expires after 0.55 seconds. Moving more than 0.6 m ends it. | 60 s | One deliberate hold of a sightline, with a long commitment before another. Break sight, flank outside the cone, grenade the position or force the Hunter to move. No damage or accuracy buff. |
| Triggerman / Second Wind | Recover up to 30 HP, capped at 100. Six 5-HP pulses at 1.5, 2, 2.5, 3, 3.5 and 4 seconds. Any damage cancels the remaining recovery. Cannot waste it at full health. | 70 s | Broadly useful recovery warrants a longer wait than reconnaissance. Push before the first pulse or land any damage to interrupt it. No overheal and no instant combat reset. |
| Vince / Breach Guard | Four seconds of 35% incoming damage reduction, rounded up after pellet aggregation. Firing any weapon or successfully throwing a grenade ends the guard before the attack. | 75 s | The strongest survival tool has the longest cooldown. Retreat for four seconds, sustain fire, or punish the unguarded shotgun attack. Full close sniper body shots and shotgun volleys still kill. |
| Run N Gun / Overrun | Three seconds of +35% movement wish speed and acceleration. Uses normal running, sliding, jumping and collision; the existing 28 m/s momentum ceiling remains. | 50 s | A short repositioning window without immunity or weapon buffs can recharge sooner. Track the route, hold corners and chokepoints, or force collisions; there is no teleport or invulnerable dash. |

All classes carry the grenade: cover pressure is a shared tactical option, leaving each class its own distinct ability. It has a **60-second cooldown**, **2.2-second fuse**, gravity-driven thrown arc, bouncing swept collision, **6 m radius**, and **65 maximum damage**. Damage falls linearly to zero (`floor(65 × (1 − distance / 6))`), measured to the target's body centre. At 3 m it deals 32; at 6 m it deals 0. Solid boxes and ramps block the blast. Spawned at the player's eye, it cannot be placed beyond a wall by a client-supplied origin. There is no cooking, remote detonation or knockback. The blinking projectile, launch sound and nearby fuse warning give opponents time to leave or take cover. It damages its owner, never TDM teammates, and cannot kill a full-health player by itself.

## 100-HP damage and time to kill

These are first-hit-to-kill times using the existing 60 Hz combat command clock, body shots at 5 m (knife 2 m). All shotgun pellets connect for the volley row. Travel to the target, accuracy, reaction time and reloads are excluded. `0 ms` means one hit; it does not mean no acquisition or projectile travel time.

| Weapon | Normal hits / TTK | Against active Breach Guard hits / TTK |
| --- | --- | --- |
| Sniper | 1 / 0 ms | 1 / 0 ms |
| Rifle | 3 / 266.7 ms | 4 / 400 ms |
| Shotgun volley | 1 / 0 ms | 1 / 0 ms |
| SMG | 4 / 250 ms | 5 / 333.3 ms |
| Pistol | 3 / 500 ms | 4 / 750 ms |
| Knife | 2 / 450 ms | 3 / 900 ms |

Partial shotgun hits matter: the close-range lethal body threshold goes from two pellets to three during guard. A close sniper leg hit goes from 101 damage (one hit) to 66 (two, 1166.7 ms apart on the command clock). Guarded rifle hits deal 28 and guarded SMG hits 20. Guarded peak grenade damage is 43.

Watchpoint and Overrun change no weapon damage, fire interval or hitbox. Second Wind leaves full-health TTK unchanged, and an uninterrupted incoming burst cancels recovery on its first hit. It can restore a wounded player's normal hit-count thresholds if given time behind cover, always within 100 HP.

A maximum-damage grenade leaves 35 HP. One rifle, pistol or knife body hit can then finish; the SMG needs two hits (83.3 ms between first and second). Those follow-up times **exclude the grenade's 2.2-second fuse**. Mid-radius damage leaves 68 HP and requires two rifle or three SMG body hits. This is a finisher/setup tool, not a full-health one-shot.

## Authority, movement and lifecycle

The wire protocol is now arena-v5. Inputs request two buttons, never a class power, target, position, damage amount or cooldown. The room validates life, alive/connected state, round phase, request age and wall-clock cooldown. Extra client properties are ignored. The client only sends a fresh key/touch edge, drops early presses and latches requests until acknowledgement. Holding a button cannot auto-activate on the next cooldown.

The server owns all healing, damage, kills, scoring, spotting and cooldowns. Grenade visuals extrapolate the shared swept trajectory between 100 ms server samples. Damage/healing updates reach both local and remote health immediately; unconfirmed gun feedback remains separate. Living movement and acknowledgements remain on the snapshot channel. Client weapon feedback accounts for the latest authoritative guard state.

Overrun grants 180 movement commands, decremented through the same movement function on server and prediction/replay, and expires after three seconds of server time even if the player withholds inputs. It never changes coordinates directly. The standard substeps, collision resolution, step height, ramp logic, jump logic and speed cap still apply. Activation itself waits for server acknowledgement; there is no speculative movement boost to correct after a rejected request.

Death and respawn cancel active abilities but preserve both cooldown deadlines. A thrown grenade survives death and may earn a posthumous kill; self-kills grant no kill/team points. Class or team changes cancel active powers and launched grenades while preserving cooldowns, HP and existing death deadlines. This prevents class cycling and team-switching ordnance exploits. Disconnect cancels active powers/projectiles, but reconnecting the session preserves cooldowns. Round end clears active powers and ordnance; a new round resets both cooldowns. Cached arena-v2/v3/v4 clients keep their original snapshot field masks; v5 clients receive tactical fields and events.

Bots have the same powers, grenades and cooldown checks. Their initial tactical reaction is 3.5 / 1.8 / 0.8 seconds for easy / normal / hard, and they reassess every 15 / 7 / 3 seconds. Decisions use visible enemies, injury, range and movement. Hunters hold position while watching; Vince saves his attack until close; runners boost while moving; Triggermen recover when wounded. Bots estimate grenade arcs only toward observed enemies and reject throws near themselves or teammates. The actual throw always uses authoritative swept physics.

## Verification and balance limits

Open [the HUD preview index](artifacts/abilities/index.html) for **24 production DOM/CSS fixtures**: all four classes × ready/active/cooldown × desktop (1024×614) and mobile (667×375). These are review pages, not browser screenshots. No browser process or CDP connection was used. Regenerate with `npx tsx tests/abilities-preview.ts`.

`tests/abilities.test.ts`, `tests/abilities-network.test.ts` and `tests/ability-hud.test.ts` cover early/forged/repeated inputs, cooldown boundaries, dead/stale/expired requests, reconnect, respawn, class/team change, round end/rematch, private spotting, healing interruption/caps, guard cancellation, grenade fuse/cover/falloff/friendly fire/self damage/kill credit, all five maps' accelerated replay parity, the speed cap, touch/keyboard edges and HUD/effect cleanup.

The first speed-only implementation barely improved running because existing ground friction capped acceleration. Testing caught this; Overrun now increases acceleration as well, retaining the normal collision path and speed limit. Bot arc planning was also simplified after the exact per-candidate simulation proved too expensive; actual projectile physics remains exact.

[The balance report](artifacts/abilities/balance.json) records ten seeded two-minute simulations (one normal bot per class, tools off/on across all five maps) and the TTK calculations. Aggregate kills off → on: Hunter 40 → 51, Triggerman 78 → 70, Vince 17 → 25, Run N Gun 78 → 81. Twelve grenades produced one grenade kill. The enabled runs' worst per-map p99 server tick was under 0.8 ms on this machine. No new dominant ability appeared in this small sample; Vince still had the fewest kills, and pre-existing SMG/rifle strength remained. This is a limited simulation check, not a human balance study or GPU/mobile performance measurement. Abilities were not used to rebalance the base weapons.

The final production build and full **392-test suite pass**. Existing movement, collision, hit-registration, interpolation, remote-health and bad-link regression tests remain green. A separate [live WebSocket hit-registration run](artifacts/abilities/hitscan.json) hit **24/24 shots at each of 0, 100 and 350 ms RTT**, with zero resyncs, zero local movement correction and zero snapshot camera jumps. Logs are in `artifacts/abilities/tests.txt` and `build.txt`.

The review patch is `/tmp/furo-abilities-dec41d6.patch`, against exact base `dec41d6328e29d41148ae6380ba915bec01d10bf`. `.git` was not written. Concurrent map documentation and test edits remain in the workspace and are excluded from the patch; `prediction.ts` includes the compatible per-map argument integration alongside the ability movement change.
