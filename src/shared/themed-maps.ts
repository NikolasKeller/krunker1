import type { MapBox, MapDefinition, MapId, Ramp } from './map';

// Architecture is authored once: every box below is rendered at precisely these
// dimensions and is used by movement, bullets and bots. Rotational symmetry
// gives both teams the same cover, route lengths and ramp access.
function create(id: Exclude<MapId, 'sandyard'>, name: string, tagline: string, palette: MapDefinition['palette']) {
    const boxes: MapBox[] = [], ramps: Ramp[] = [];
    const add = (x: number, z: number, w: number, h: number, d: number, color: number, kind: MapBox['kind'] = 'wall', bottom = 0, surface?: MapBox['surface']) => {
        boxes.push({ x, y: bottom + h / 2, z, w, h, d, color, kind, surface });
    };
    const pair = (x: number, z: number, w: number, h: number, d: number, color: number, kind: MapBox['kind'] = 'wall', bottom = 0) => {
        add(x, z, w, h, d, color, kind, bottom); add(-x, -z, w, h, d, color, kind, bottom);
    };
    const incline = (x: number, z: number, w: number, d: number, h: number, axis: Ramp['axis'], sign: number, color: number) => {
        ramps.push({ x, z, w, d, h, axis, sign, color });
    };
    const metal = id === 'orbital' ? 0x65758f : 0x36787f;
    const stone = id === 'wildroot' ? 0x678657 : 0x716485;
    const wall = id === 'orbital' || id === 'abyss' ? metal : stone;
    // Continuous 76 m shell. Windows are solid glass volumes, with no holes
    // between sill, pane, lintel and jambs. Corners overlap by one metre.
    for (const side of [-1, 1]) {
        add(0, side * 38, 78, 10, 2, wall);
        if (id === 'orbital' || id === 'abyss') {
            add(side * 38, 0, 2, 1.5, 76, wall);
            add(side * 38, 0, 2, 3, 76, wall, 'wall', 7);
            for (const z of [-30, -10, 10, 30]) {
                add(side * 38, z, 2, 5.5, 16, id === 'orbital' ? 0x4369a3 : 0x38c9d1, 'wall', 1.5, 'glass');
                add(side * 38, z + 9, 2, 5.5, 2, wall, 'wall', 1.5);
                add(side * 38, z - 9, 2, 5.5, 2, wall, 'wall', 1.5);
            }
        } else add(side * 38, 0, 2, 10, 76, wall);
    }
    // Five protected pockets per side, with two exits each into a cross lane.
    // Ten positions per team spread respawns away from occupied/visible pockets.
    const spawns: MapDefinition['spawns'] = [];
    for (const z of [33, 35]) for (const x of [-26, -13, 0, 13, 26]) {
        spawns.push({ x, y: 0, z, yaw: 0 }, { x: -x, y: 0, z: -z, yaw: Math.PI });
    }
    for (const x of [-26, -13, 0, 13, 26]) pair(x, 28, 8, 3.6, 2, wall, 'cover');
    if (id === 'orbital') {
        // Split reactor atrium, two raised observation decks, four ramp entries.
        add(0, 0, 6, 8, 6, 0x374766, 'building');
        add(0, 0, 6.4, .55, 6.4, 0x7df5ed, 'cover', 6, 'light');
        for (const y of [1.5, 4]) add(0, 0, 6.1, .18, 6.1, 0x80d5f0, 'wall', y, 'light');
        pair(0, 33, 74, .5, 8, 0x4b607e, 'wall', 9.5);
        pair(0, -19, 18, .4, 12, 0x4b607e, 'wall', 8.5);
        for (const x of [-18, 18]) {
            add(x, 0, 10, 3, 12, 0x8295b5, 'platform');
            for (const z of [-11, 11]) incline(x, z, 8, 10, 3, 'z', z < 0 ? 1 : -1, 0xa5b7d1);
            add(x, 0, 2, 2.2, 4, 0x465779, 'cover', 3);
        }
        pair(-8, -18, 2, 6, 12, metal);
        pair(8, -19, 2, 6, 10, metal);
        pair(-27, -17, 8, 4, 3, 0xd19b60, 'cover');
        pair(-29, 6, 4, 2.5, 5, 0x566d91, 'cover');
        // Roof ribs stay above headroom and belong to the collision model too.
        for (const z of [-20, 20]) add(0, z, 72, .5, .6, 0x93acd4, 'wall', 8.5);
        for (const x of [-8, 8]) add(x, 0, .35, .2, 40, 0x83f2ff, 'wall', 8.7, 'light');
    } else if (id === 'abyss') {
        // Dry raised pump deck, outside observation galleries, staggered machinery.
        add(0, 0, 12, 3, 10, 0x479da0, 'platform');
        incline(-11, 0, 10, 7, 3, 'x', 1, 0x7bbfc0);
        incline(11, 0, 10, 7, 3, 'x', -1, 0x7bbfc0);
        add(0, 0, 3, 2.4, 3, 0xf0bb60, 'cover', 3);
        add(0, 0, 3.3, .22, 3.3, 0x9bebdf, 'wall', 5.4, 'light');
        pair(0, 33, 74, .5, 8, 0x285b6c, 'wall', 9.5);
        pair(-17, -15, 3, 5, 16, 0x36787f);
        pair(8, -18, 10, 3.2, 3, 0x467f91, 'cover');
        pair(-28, -18, 8, 5, 9, 0x9db79e, 'building');
        pair(-28, -18, 6.5, 1, 7.5, 0xc8cdab, 'wall', 5);
        for (const x of [-29, -26]) pair(x, -18, .65, 2, .65, 0xd5a95b, 'wall', 6);
        pair(-27, 2, 7, 2.4, 3, 0xe2ac5f, 'cover');
        // Squared pressure pipes: exact solid segments, including their risers.
        for (const side of [-1, 1]) {
            add(side * 34.5, 0, .8, .8, 50, 0xd5a95b, 'wall', 5.8);
            for (const z of [-24, 0, 24]) {
                add(side * 34.5, z, .8, 5.8, .8, 0xd5a95b);
                add(side * 34.5, z, 1.2, .3, 1.2, 0x275e69, 'wall', 4.5);
            }
        }
        pair(-17, -15, 4.5, .5, 17, 0x80c7bf, 'wall', 5);
    } else if (id === 'wildroot') {
        // A stepped temple island, fallen trunks and terraced rock outcrops.
        add(0, 0, 12, 3, 12, 0xb8b083, 'platform');
        incline(0, -11, 8, 10, 3, 'z', 1, 0x9c9e72);
        incline(0, 11, 8, 10, 3, 'z', -1, 0x9c9e72);
        pair(-4.5, 0, 2, 5, 2, 0x78846a, 'wall', 3);
        add(0, 0, 11, .8, 2, 0xadb18a, 'wall', 8);
        for (const [x, z] of [[-20, -16], [22, -10], [-26, 8], [13, 21]]) {
            pair(x, z, 7, 2.6, 5, 0x788a5d, 'cover');
            pair(x + .5, z, 5, 1.6, 4, 0x9da272, 'cover', 2.6);
        }
        pair(-15, 9, 3, 2.2, 10, 0x886943, 'cover');
        // Voxel trees give solid, readable natural cover instead of crate stacks.
        for (const [x, z] of [[-28, -22], [-13, -19], [27, -1], [-20, 19], [12, 16]]) {
            pair(x, z, 2, 10, 2, 0x72583e);
            pair(x, z, 10, 2.5, 8, 0x3d8652, 'wall', 9);
            pair(x, z, 7, 2, 6, 0x72af59, 'wall', 11.5);
        }
        for (const x of [-32, 32]) for (const z of [-12, 12]) {
            add(x, z, 4, 1, 5, 0x5d9b4b, 'cover');
            add(x, z, 2, .8, 3, 0x99bb53, 'cover', 1);
        }
        // Canopy over the outer routes; the floor beneath stays open to flank.
        for (const x of [-32, 32]) for (const z of [-25, 0, 25]) {
            add(x, z, 1.3, 11, 1.3, 0x72583e);
            add(x, z, 9, 2, 11, 0x378550, 'wall', 10);
            add(x + Math.sign(x), z, 6, 2, 7, 0x66aa51, 'wall', 12);
        }
    } else {
        // Dogleg corridors open into a vaulted central crypt and side chapels.
        pair(-12, -15, 2, 7, 20, stone);
        pair(12, -16, 2, 7, 18, stone);
        pair(-21, -6, 16, 7, 2, stone);
        pair(-26, 16, 2, 6, 14, 0x655d7a);
        add(0, 0, 10, 2.8, 10, 0x8f8196, 'platform');
        incline(-10, 0, 10, 7, 2.8, 'x', 1, 0xa496a6);
        incline(10, 0, 10, 7, 2.8, 'x', -1, 0xa496a6);
        add(0, 0, 3, 1.8, 4, 0x5a526f, 'cover', 2.8);
        pair(-21, 15, 3, 1.8, 6, 0x9c8998, 'cover');
        pair(-6, -20, 3, 2.3, 4, 0x92828b, 'cover');
        for (const x of [-8, 8]) for (const z of [-7, 7]) add(x, z, 2, 9, 2, 0x90839e);
        for (const z of [-7, 7]) add(0, z, 18, 1, 2, 0xaca0b3, 'wall', 9);
        // Covered side galleries and a stepped vault over the crypt.
        pair(-20, -16, 16, .6, 20, 0x5a526f, 'wall', 7);
        for (const x of [-6, 6]) add(x, 0, 6, .7, 14, 0x756782, 'wall', 10);
        add(0, 0, 6, .7, 14, 0x92809d, 'wall', 11);
        // Torch brackets and flames are small solid blocks; no decorative
        // obstacle can silently bypass the audit or bullet occlusion.
        for (const [x, z] of [[-10.6, -17], [10.6, 17], [-24, -4.6], [24, 4.6], [-36.5, 15], [36.5, -15]]) {
            add(x, z, .35, 1, .35, 0x5b4358, 'wall', 2.5);
            add(x, z, .45, .8, .45, 0xffbb57, 'wall', 3.5, 'light');
        }
    }
    return { id, name, tagline, size: 76, boundaryHeight: 10, boxes, ramps, spawns, palette };
}
export const themedMaps: MapDefinition[] = [
    create('orbital', 'ORBITAL', 'REACTOR DECKS. A WORLD BELOW.', { sky: 0x101a35, floor: 0x435573, ambient: 0xb4d9ff, sun: 0xa4deff, intensity: 1.6 }),
    create('abyss', 'ABYSS', 'UNDER PRESSURE. KEEP MOVING.', { sky: 0x123e56, floor: 0x316a77, ambient: 0x8be5df, sun: 0x8deff5, intensity: 1.7 }),
    create('wildroot', 'WILDROOT', 'OLD RUINS. NEW RIVALS.', { sky: 0xb2d1a1, floor: 0x9c9f61, ambient: 0xe1f2bb, sun: 0xffe7a1, intensity: 2.1 }),
    create('catacomb', 'CATACOMB', 'TIGHT TURNS. TORCHLIT TOMBS.', { sky: 0x302b47, floor: 0x655c73, ambient: 0xc9b9dc, sun: 0xffbe79, intensity: 1.3 }),
];
