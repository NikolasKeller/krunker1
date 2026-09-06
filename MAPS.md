# Five-map rotation

Every arena uses the original 76 m footprint and the same movement physics. Hosts
choose a map in the lobby, or leave **Random each round** selected. The server
draws the next map when creating the lobby or returning from results. Ready-up
and countdown never reroll the map already shown to everyone. Guests and late
arrivals receive that resolved map, including in compact touch layouts.

| Map | Layout and weapon spaces | Vertical routes |
| --- | --- | --- |
| Sandyard | Existing yard, buildings, side lanes, cover and bridge underpass | Three ramps to the central deck |
| Orbital | Metal approach corridors, split reactor atrium, flanking observation galleries, solid viewports onto a planet and starfield | Two observation decks, each with two ramp entries |
| Abyss | Pump machinery breaks rifle lanes; outer window galleries and staggered pressure pipes offer close flanks; kelp and seabed sit outside the glass | Two opposing ramps to the pump deck |
| Wildroot | Temple ruins, terraced rocks, fallen trunks, dense voxel canopy and light pools; natural cover replaces crates | Two ramps to the temple island |
| Catacomb | Dogleg stone corridors, covered side galleries, torchlit crypt and side chapels | Two opposing ramps into the raised, vaulted crypt |

New maps have five shielded spawn pockets on each end, with two spawn positions
per pocket and multiple exits. Rotational symmetry gives both teams equivalent
cover and ramp access. Respawns prefer unoccupied locations with fewer enemy
sightlines. Independent west/east routes keep elevated and long-range positions
flankable. Bot navigation, hitscan and server movement receive the room's map
explicitly; client prediction changes maps with the authoritative snapshot and
clears interpolation and pending movement from the previous world.

## Geometry contract

`src/shared/map.ts` registers all five maps; `src/shared/themed-maps.ts` authors
the new solids, ramps, spawns and palettes. The themed renderer uses those exact
dimensions. Architecture, roof slabs, pipework, foliage and torch brackets are
solid; viewports are solid glass. Face inlays use depth bias instead of projecting
beyond their parent collider. Stars and distant landscape stay outside playable
bounds; floor paint is at most 2.5 cm thick. Standard movement and gravity apply
to every map.

The permanent audit checks rendered bounds, reverse collider coverage, every
ramp vertex against its wedge, mesh ownership, and all vertical bands of the
outer shell. Its negative tests include a 0.2 mm window/lintel slit and an
oversized invisible collider. Production batching must preserve every audited
triangle, including glass and emitters.

## Reproduce verification and previews

```sh
npm run audit:map
npm run test:maps
npm test
npm run build
npm run preview:maps
npm run preview:geometry
```

`preview:maps` extends the repository's software geometry rasterizer. It writes
three PNG views per arena, a contact sheet, a camera manifest and a review page
to `artifacts/maps/`. Open `artifacts/maps/index.html` to review them. It launches
no browser and uses no CDP connection. Lighting is approximated; WebGL shadows
and canvas signs are omitted.

Verified on 2026-09-06: all 353 tests pass, production build passes, all five maps
have zero bounds mismatches. Collision regression covers 40,200 solid-face
approaches at the 28 m/s speed cap, five approach angles, air/slide/hop modes,
normal and extended ticks, plus 278,400 assembled-map movement steps. Every ramp
is checked for climbing, side/end entry and fast falls; every solid top and
underside is checked at 400 m/s vertical speed. Layout checks cover spawn
clearance, exits, bot connectivity, independent flanks and spawn sightlines.

These checks establish geometry, movement and lobby correctness. Weapon balance
and visual lighting still benefit from human playtesting in the rendered game.
