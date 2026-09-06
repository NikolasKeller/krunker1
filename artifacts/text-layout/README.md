# Text clipping verification

Class selection lives only in the lobby. The obsolete `class-selection` layout
state is replaced by `home`, with no class picker. Both lobby states retain
coverage of every class name and role, including text overflow.

The class cards now use content height with the existing breakpoint heights as
minimums. Both labels wrap, including unbroken names, and use a 1.2 line-height.
The bundled Squada One font's `head`/`hhea` tables report 1000 units/em, an ascent
of 861, a descent of -196, and no line gap: 1.057 em before additional leading.
The old name line-height was 1 em. Card artwork still clips at its border; label
line boxes contribute to card height. Home sections cannot flex-shrink into each
other and remain reachable through the existing scroll container.

## Render and assert

Generate self-contained previews without a browser:

```sh
npm run preview:text-layout
python3 -m http.server 4174 --bind 127.0.0.1
```

Open `http://127.0.0.1:4174/artifacts/text-layout/index.html` for the complete
matrix. Its iframes supply 1440×900, 1280×800, 844×390, and 667×375 viewports for
home, lobby, full lobby, HUD, and scoreboard. Touch fixtures
preserve the production `touch-device` class; viewport size alone does not enable
touch layout. All CSS, fonts, and assertion code are embedded. No game server,
WebGL, browser launcher, or CDP connection is required by the generator.

For full-size screenshots, open individual pages at the desired viewport:

- Desktop: `home.html`, `lobby.html`, `lobby-full.html`.
- Landscape phone: `home-touch.html`, `lobby-touch.html`, `lobby-full-touch.html`.
- Additional audit: `hud.html`, `scoreboard.html` and their `-touch` variants.

Home retains the real callsign and create/join controls, with no class cards. Its
character stage is empty in these static typography fixtures. For the animated
production character, run `npm run preview:home`, open
`/artifacts/home-preview/index.html`, and await `window.__homePreview.ready` and
`document.fonts.ready`. `npm run preview:lobby` generates the additional lobby
states in `/artifacts/lobby-preview/`. Regeneration removes the obsolete
`class-selection*.html` pages so reviews cannot use stale home markup.

Wait for `window.__textLayout.ready`, then call `window.__textLayout.assert()`
in the external renderer. It throws on text overflow. The report is available
at `window.__textLayout.report`; `<html data-text-layout="pass|fail">` also exposes
the outcome. For the complete matrix, wait for `window.__textLayoutMatrix.ready`
and call `window.__textLayoutMatrix.assert()`. Its reports identify the failing
viewport, text, containing element, and axis. Scroll content is checked inside
its component even when offscreen; scrollable ancestors are treated as reachable.

Append `?stress=1` to an individual lobby page to extend both class labels with
`gypqj LongUnbrokenPlaystyleName`, exercising descenders and additional wrapped
lines. Resize to repeat measurements. Screenshot home and lobby at
1440×900 and 1280×800, then review both landscape phone sizes. Scroll the lobby
sidebar to its class cards and the full roster through its last player.

## Related audit findings

| Area | Source/metric finding | Action |
| --- | --- | --- |
| Lobby class cards | Fixed 67px/65px heights with the same inherited clipping and tight name line-height. | Content-sized at every breakpoint, wrapping labels. |
| Home callsign | At 1280×800 the 44px border box reserved only 22px after padding/borders, below the 23px font's 24.311px ascent/descent extent. | Auto height, minimum touch target and 1.2 line-height. |
| Lobby map panel | Fixed 75px height, hidden overflow and multiple text lines; could clip as map copy wraps. | Auto height, no flex shrink, full title line box; artwork remains contained. |
| Team lineup | Minimum card heights, wrapping names, padded rows and scrollable roster. | No matching fixed-height clipping constraint found; included in previews. |
| Buttons | Main actions use content/minimum height and padding. | No matching clipping constraint found; included in previews. |
| Scoreboard | Content-sized table rows in a scrolling panel. | No matching fixed-row clipping constraint found; 17-player fixture included. |
| HUD health | Text sits in an absolutely positioned 34px bar with 2px borders and 3px top padding; 32px desktop / 36px touch type exceeds the nominal interior height. Overflow is visible, so this is not the cards' hidden-overflow clipping. | Left unchanged; the strict bounds audit may report `.health-content`. Confirm actual glyph visibility in the external screenshot. |

Browser screenshots and actual range measurements are **pending the calling
agent**. No browser was launched here. Source/metric findings are not represented
as screenshots or browser-verified results. The strict matrix also audits the
existing HUD bounds issue above; inspect failures rather than ignoring them.

## Automated coverage

`npm test` includes `tests/text-layout.test.ts`: it guards sizing/wrapping at all
CSS breakpoints, reads the currently declared bundled font's metrics, checks
preview markup and visible lobby class-card targets, and verifies that the DOM overflow assertion rejects a sliced
label, ancestor clipping and horizontal overflow. A synthetic geometry test
exercises the detector; it does not claim jsdom can lay out text. The browser
assertion explicitly rejects environments without a layout engine.

Reconciliation validation logs: `/tmp/krunker-reconcile-tests.log` and
`/tmp/krunker-reconcile-build.log`.
