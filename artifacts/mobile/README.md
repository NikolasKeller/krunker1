Implemented against base revision `c08b9ce553c402dead2733501e0b236ec56a4345`.

Touch play uses runtime pointer capability and actual pointer events, with keyboard input retained. The floating left joystick preserves analogue magnitude through the shared movement simulation. The right FIRE button also accepts look drags, so moving, aiming and shooting work with two thumbs. AIM toggles; jump, slide, reload, all three weapons, pause and scoreboard have touch controls. Short action taps survive until consumed by a simulation command. Pointer cancellation, lost capture, tab hiding, focus loss, death and portrait rotation clear touch input. Desktop still uses pointer lock and its existing sensitivity.

Chat input, microphone, log, client receive callback and Enter wiring were removed. The server retains its authenticated, bounded, rate-limited legacy chat handling, with its socket test. The lobby loadout-details markup and control instruction strip were removed; class selection remains.

Reload starts on the magazine-emptying shot on both client and server. Its duration and viewmodel animation are unchanged. Repeated R does not extend reload. Switching cancels it and still uses the combat pass's 180 ms command-clock delay. The server alone completes the reload and grants ammunition. Older snapshots preserve provisional ammunition/reload state; disagreement restores authority without notices.

Aim assist is touch-only, requires an active look drag, targets visible enemy torsos within roughly 4 degrees and 65 metres, and excludes cover, friends, dead players and spawn protection. Slowdown is at most 18%; magnetism is capped at 6 degrees/second and 12% of the user's drag, with falloff toward the edge of the cone. No head snapping or idle tracking. Hitboxes and damage are identical across platforms. These mathematical limits are tested; competitive balance still needs human playtesting.

Verification completed:

- `npm run build` (TypeScript, Vite client and bundled server).
- `npm test`: 220 tests passed. Includes touch math/pointers, hybrid startup, reload lifecycle, existing socket tests and desktop combat/movement regression coverage.
- `npm run test:ammo:latency`: frame-phase sweeps at 60, 120, 144 and 240 Hz, with pre-input authority delayed by 0 or 350 ms. At 60 Hz, worst input-to-DOM delay fell from 33.332 ms to 16.666 ms at both RTTs; all tested refresh rates now stay within one frame. See ammo-before.json and ammo-after.json. These are deterministic render-loop/DOM measurements, not physical input-to-photon measurements.
- `tests/mobile-game.test.ts` executes the actual production game loop and actual UI/input/prediction, replacing only GPU/audio devices. Touch and desktop at 0/350 ms RTT start correctly and update ammo plus reload pose in the first shot frame.
- `npm run preview:mobile`: nine phone fixtures generated in ../mobile-preview/. No browser launch or CDP connection was attempted.

Performance changes and measured geometry:

- Existing static map batching is retained: 7 meshes, 15,958 triangles; 16 remote characters use 96 meshes in the geometry test.
- Phone default: no MSAA, no shadow pass, pixel ratio at most 1 (previous balanced cap: 1.35), no lobby character preview pass, and no modal backdrop blur. There was no scene postprocessing chain to remove.
- At 844 × 390, the default pixel budget drops from approximately 600k to 329k pixels (45% less). Touch balanced shadows use 512², high uses 1024², compared with desktop 1536². Phone high caps DPR at 1.15.
- Far plane is 120 rather than 220; the 76 × 76 arena fits within it. Fog fades from 70 to 120.
- Mobile rendering caps at 60 Hz, including high-refresh displays. Sustained slow frames lower resolution to .85 then .70 before latching a paced 30 Hz mode. Changing graphics quality resets that adaptation. Desktop frame pacing is unchanged.
- `window.__arena.metrics` exposes measured FPS, targetHz, pixelRatio, touch mode, draw calls and triangles for the external verifier.

External review still required (this sandbox cannot run a browser):

Serve this repository with `python3 -m http.server 8765`, then open `/artifacts/mobile-preview/index.html`. Screenshot match, moving, reloading, lobby, full-lobby, invite, scoreboard and settings at 844 × 390 and 667 × 375; check portrait at 390 × 844. The folder is portable and includes its own renderer bundle/fonts/background. These pages are frozen layout fixtures, not live network matches.

Use `npm run dev` for the live invite flow. In a real mobile browser verify invite → ready → tap to play; simultaneous move/fire-drag; aim, slide-hop, reload and weapon switching; scoreboard/settings; portrait → landscape resume; and a ten-player lobby. Safe-area CSS requires a device/browser that supplies actual inset values. Check browser-edge swipe and pinch behavior on iOS Safari and Android Chrome; CSS/touch cancellation cannot disable operating-system navigation gestures.

Record real device frame times for a sustained match on a mid-range phone, including a full room and effects. Neither stable hardware 60 FPS nor phone-versus-desktop win-rate parity is claimed by this headless verification. Evaluate those with actual hardware and players before treating competitive parity as verified.
