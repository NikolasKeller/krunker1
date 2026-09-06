import assert from 'node:assert/strict';
import test from 'node:test';
import { MAPS, rampHeight, type MapDefinition } from '../src/shared/map';
import { HEIGHT, RADIUS } from '../src/shared/movement';
import { worldHit } from '../src/shared/math';
import { findPath } from '../src/server/bots';

function clear(map: MapDefinition, x: number, z: number, y = 0) {
    return !map.boxes.some(b => Math.abs(x - b.x) < b.w / 2 + RADIUS && Math.abs(z - b.z) < b.d / 2 + RADIUS &&
        y < b.y + b.h / 2 - 1e-8 && y + HEIGHT > b.y - b.h / 2 + 1e-8) &&
        !map.ramps.some(r => (rampHeight(r, x, z) ?? 0) > y);
}
function sightline(map: MapDefinition, a: { x: number; y: number; z: number }, b: typeof a) {
    const delta = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }, length = Math.hypot(delta.x, delta.y, delta.z);
    return worldHit(a, { x: delta.x / length, y: delta.y / length, z: delta.z / length }, length, map) >= length - .001;
}

for (const map of MAPS) {
    test(`${map.name}: spawn bodies are clear, connected, and have multiple independent flanking routes`, () => {
        assert.equal(map.size, 76);
        assert.ok(map.spawns.length >= 20);
        for (const spawn of map.spawns) {
            assert.ok(clear(map, spawn.x, spawn.z, spawn.y), `blocked spawn ${JSON.stringify(spawn)}`);
            const exits = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([x, z]) => clear(map, spawn.x + x * 2, spawn.z + z * 2, spawn.y));
            assert.ok(exits.length >= 2, `single-exit spawn ${JSON.stringify(spawn)}`);
            assert.ok(findPath(spawn, map.spawns[(map.spawns.indexOf(spawn) + 1) % map.spawns.length], map).length > 0, 'bots can navigate between spawn areas');
        }
        // Separate west/east paths, constrained to opposite sides of the arena.
        // Search real body-clear floor space independently of the bot graph.
        for (const side of [-1, 1]) {
            const seen = new Set<string>(), queue: [number, number, number][] = [];
            for (let x = 7; x <= 35; x++) if (clear(map, x * side, -32)) {
                queue.push([x * side, -32, 0]); seen.add(`${x * side},-32`);
            }
            let route = 0;
            for (let cursor = 0; cursor < queue.length; cursor++) {
                const [x, z, distance] = queue[cursor];
                if (z === 32) { route = distance; break; }
                for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                    const nx = x + dx, nz = z + dz, key = `${nx},${nz}`;
                    if (nx * side < 7 || nx * side > 35 || Math.abs(nz) > 32 || seen.has(key) || !clear(map, nx, nz)) continue;
                    seen.add(key); queue.push([nx, nz, distance + 1]);
                }
            }
            assert.ok(route >= 64 && route <= 110, `${side < 0 ? 'west' : 'east'} route missing or too slow: ${route}`);
        }
    });
    if (map.id !== 'sandyard') test(`${map.name}: mirrored team pockets resist central sniping and one camper cannot see all spawns`, () => {
        const blue = map.spawns.filter((_, i) => i % 2 === 0), red = map.spawns.filter((_, i) => i % 2 === 1);
        for (let i = 0; i < blue.length; i++) {
            assert.equal(blue[i].x, -red[i].x); assert.equal(blue[i].z, -red[i].z);
            for (const [x, z] of [[blue[i].x, 22], [red[i].x, -22]]) {
                const target = z > 0 ? blue[i] : red[i];
                assert.equal(sightline(map, { x, y: 1.62, z }, { ...target, y: 1.62 }), false, 'pocket cover blocks approach sightlines');
            }
        }
        for (let x = -34; x <= 34; x += 4) for (let z = -24; z <= 24; z += 4) {
            if (!clear(map, x, z)) continue;
            for (const team of [blue, red]) {
                const visible = team.filter(spawn => sightline(map, { x, y: 1.62, z }, { ...spawn, y: 1.62 }));
                assert.ok(visible.length < team.length / 2, `dominant camper at ${x},${z}: sees ${visible.length}/${team.length}`);
            }
        }
    });
}
