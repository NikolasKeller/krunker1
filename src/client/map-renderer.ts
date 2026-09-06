import * as THREE from 'three';
import { BOXES, DETAIL_BOXES, FENCE_BOXES, BUILDING_ROOFS, ROOF_VENTS, RAMPS, type MapBox, type Ramp } from '../shared/map';
import { batchMeshes, box, material } from './models';
export interface MapObject {
    id: string;
    group: THREE.Group;
    collider?: MapBox;
    ramp?: Ramp;
    building?: MapBox;
    decoration?: 'ground' | 'paint' | 'skyline' | 'fabric';
}
function visualBody(b: MapBox): MapBox {
    // Reserve space INSIDE the authored collision footprint for the existing
    // ledges, plinths and trim. These are fixed design dimensions, never fitted
    // to measured bounds: the geometry audit must catch future protrusions.
    if (b.kind === 'building') return { ...b, w: b.w - (b.w > 5 ? .42 : .05), d: b.d - (b.w > 5 ? .76 : .05) };
    if (b.kind === 'crate') return { ...b, w: b.w - (b.w > 4 ? .04 : 0), d: b.d - (b.w > 4 ? .26 : .22) };
    if (b.kind === 'cover' && b.h > 2) return { ...b, w: b.w - .1, d: b.d - .164, y: b.y - .03, h: b.h - .06 };
    if (b.kind === 'wall' && b.h === 6) return { ...b, w: b.w - (b.w < b.d ? .08 : 0), d: b.d - (b.d < b.w ? .08 : 0) };
    return b;
}
function sign(scene: THREE.Object3D, text: string, x: number, y: number, z: number, width: number, height: number, rotation = 0, bg = '#263c3c', fg = '#eae3ce') {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 128;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, 512, 128);
    ctx.fillStyle = fg;
    ctx.font = '900 65px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 256, 67);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ map: texture }));
    mesh.position.set(x, y, z);
    mesh.rotation.y = rotation;
    scene.add(mesh);
}
export function buildMap(scene: THREE.Scene, { batch = true } = {}) {
    // Keep object ownership until batching so headless audits measure the very
    // same meshes (including signs and rotated details) that the game renders.
    const objects: MapObject[] = [];
    function object(id: string, physics: Omit<MapObject, 'id' | 'group'>) {
        const group = new THREE.Group();
        group.name = id;
        objects.push({ id, group, ...physics });
        scene.add(group);
        return group;
    }
    const boxGroups = new Map<MapBox, THREE.Group>();
    let staticGroup = object('ground', { decoration: 'ground' });
    box(staticGroup, 0, -0.25, 0, 180, 0.5, 180, 0xb98065);
    for (const collider of BOXES) {
        const b = visualBody(collider);
        const staticGroup = object(`box:${BOXES.indexOf(collider)}:${b.kind}`, { collider, building: b.kind === 'building' ? collider : undefined });
        boxGroups.set(collider, staticGroup);
        // These vans occupy the two existing low cover volumes, keeping movement/hitscan intact.
        if (b.kind === 'cover' && b.w === 7 && b.h === 1.7) {
            const body = 0xd4cfc0, glass = 0x30383c, tyre = 0x303233;
            box(staticGroup, b.x + .03, .66, b.z, 6.94, .65, 1.95, body);
            box(staticGroup, b.x + .35, 1.3, b.z, 5.5, .8, 1.86, body);
            box(staticGroup, b.x - 2.9, .95, b.z, 1.2, .15, 1.94, body);
            for (const side of [-1, 1]) {
                for (const x of [-1.75, -.25, 1.25, 2.65]) {
                    box(staticGroup, b.x + x, 1.31, b.z + side * .94, 1.25, .56, .035, glass);
                    box(staticGroup, b.x + x + .4, .9, b.z + side * .985, .2, .045, .025, 0x656563);
                }
                for (const x of [-2.3, 2.3]) {
                    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(.45, .45, .16, 10), material(tyre));
                    wheel.rotation.x = Math.PI / 2; wheel.position.set(b.x + x, .45, b.z + side * .91); staticGroup.add(wheel);
                    const hub = new THREE.Mesh(new THREE.CylinderGeometry(.25, .25, .17, 10), material(0x969795));
                    hub.rotation.x = Math.PI / 2; hub.position.copy(wheel.position); staticGroup.add(hub);
                }
            }
            box(staticGroup, b.x - 2.43, 1.31, b.z, .035, .56, 1.68, glass);
            box(staticGroup, b.x - 3.4825, .67, b.z, .035, .26, 1.25, 0x656563);
            for (const z of [-.77, .77]) box(staticGroup, b.x - 3.48, .81, b.z + z, .04, .22, .25, 0xf0dfaf);
            continue;
        }
        box(staticGroup, b.x, b.y, b.z, b.w, b.h, b.d, b.color);
        if (b.kind === 'wall' && b.h === 6) {
            const alongX = b.w > b.d, length = alongX ? b.w : b.d;
            const inner = alongX ? b.z - Math.sign(b.z) * (b.d / 2 + .02) : b.x - Math.sign(b.x) * (b.w / 2 + .02);
            box(staticGroup, alongX ? b.x : inner, .25, alongX ? inner : b.z, alongX ? length : .04, .5, alongX ? .04 : length, 0x656563);
            for (let n = 0; n < 60; n++) {
                const offset = -length / 2 + 1.5 + (n * 7.13 % (length - 3));
                const y = .9 + (n * 1.31 % 4.5), width = .8 + n % 4 * .4;
                box(staticGroup, alongX ? offset : inner, y, alongX ? inner : offset, alongX ? width : .025, .28 + n % 3 * .12, alongX ? .025 : width, n % 3 ? 0x969795 : 0x777875);
            }
        }
        if (b.kind === 'building') {
            box(staticGroup, b.x, b.y - b.h / 2 + 0.3, b.z, b.w + 0.05, 0.6, b.d + 0.05, 0x656563);
            if (b.w > 5) {
                // Exposed blockwork breaks up broad plaster faces without image assets.
                for (const side of [-1, 1]) for (let row = 0; row < 3; row++) {
                    for (let column = 0; column < 4; column++) {
                        const x = b.x - b.w * .39 + column * 1.35 + (row % 2) * .55;
                        box(staticGroup, x, .85 + row * .38, b.z + side * (b.d / 2 + .045), 1.05, .27, .06, row % 2 ? 0x777875 : 0xa8a7a0);
                    }
                }
                for (const x of [-0.28, 0.28])
                    for (const s of [-1, 1]) {
                        box(staticGroup, b.x + b.w * x, b.y + 0.7, b.z + s * (b.d / 2 + 0.025), 1.75, 1.85, 0.08, 0x526669);
                        box(staticGroup, b.x + b.w * x, b.y + 0.68, b.z + s * (b.d / 2 + 0.075), 1.38, 1.48, 0.04, 0x364b50);
                        box(staticGroup, b.x + b.w * x, b.y - 0.28, b.z + s * (b.d / 2 + 0.18), 2.05, 0.18, 0.4, 0xb4b1a9);
                        box(staticGroup, b.x + b.w * x, b.y + 0.68, b.z + s * (b.d / 2 + 0.11), 0.075, 1.55, 0.04, 0x9baca4);
                    }
                for (const side of [-1, 1]) {
                    const face = b.x + side * (b.w / 2 + .06);
                    box(staticGroup, face, 1.325, b.z, .1, 2.65, 1.75, 0x465663);
                    for (const offset of [-.28, .28]) {
                        box(staticGroup, face, b.y + .7, b.z + b.d * offset, .08, 1.85, 1.75, 0x526669);
                        box(staticGroup, face + side * .045, b.y + .68, b.z + b.d * offset, .04, 1.48, 1.38, 0x364b50);
                        box(staticGroup, face, b.y - .28, b.z + b.d * offset, .3, .18, 2.05, 0xb4b1a9);
                    }
                }
            }
        }
        if (b.kind === 'crate') {
            // Bands split the large cover crates into a visibly stacked pair without changing bounds.
            if (b.w > 4) {
                box(staticGroup, b.x, b.y, b.z, b.w + .04, .12, b.d + .04, 0x65503d);
                for (const side of [-1, 1]) for (const column of [-1, 1]) for (const row of [-1, 1]) {
                    const x = b.x + column * b.w / 4, y = b.y + row * b.h / 4, z = b.z + side * (b.d / 2 + .045);
                    box(staticGroup, x, y, z, b.w / 2 - .1, b.h / 2 - .08, .07, row > 0 ? 0xa27850 : 0xb98a58);
                    for (const edge of [-1, 1]) {
                        box(staticGroup, x + edge * (b.w / 4 - .1), y, z + side * .05, .14, b.h / 2, .07, 0xd1a368);
                        box(staticGroup, x, y + edge * (b.h / 4 - .1), z + side * .05, b.w / 2, .14, .07, 0xd1a368);
                    }
                    const brace = box(staticGroup, x, y, z + side * .05, Math.hypot(b.w / 2 - .3, b.h / 2 - .3), .12, .07, 0x65503d);
                    brace.rotation.z = column * Math.atan2(b.h / 2 - .3, b.w / 2 - .3);
                }
                continue;
            }
            for (const s of [-1, 1]) {
                for (const t of [-1, 1]) {
                    box(staticGroup, b.x + t * (b.w / 2 - 0.15), b.y, b.z + s * (b.d / 2 + 0.025), 0.22, b.h, 0.08, 0x876039);
                    box(staticGroup, b.x, b.y + t * (b.h / 2 - 0.14), b.z + s * (b.d / 2 + 0.05), b.w, 0.20, 0.12, 0xd1a368);
                }
                const brace = box(staticGroup, b.x, b.y, b.z + s * (b.d / 2 + 0.06), Math.hypot(b.w - 0.4, b.h - 0.4), 0.15, 0.10, 0xd5a86c);
                brace.rotation.z = Math.atan2(b.h - 0.4, b.w - 0.4);
                for (let x = -b.w / 2 + 0.65; x < b.w / 2; x += 0.65)
                    box(staticGroup, b.x + x, b.y, b.z + s * (b.d / 2 + 0.015), 0.025, b.h - 0.2, 0.025, 0x9c713f);
            }
        }
        if (b.kind === 'cover' && b.h > 2) {
            for (let x = -b.w / 2 + 0.3; x < b.w / 2; x += 0.6)
                for (const s of [-1, 1])
                    box(staticGroup, b.x + x, b.y, b.z + s * (b.d / 2 + 0.04), 0.08, b.h - 0.2, 0.08, b.color);
            box(staticGroup, b.x, b.y + b.h / 2, b.z, b.w + 0.1, 0.12, b.d + 0.1, 0x345559);
        }
    }
    for (const collider of BOXES.filter(b => b.kind === 'building' && b.w > 5)) {
        const b = visualBody(collider), staticGroup = boxGroups.get(collider)!;
        for (const side of [-1, 1]) {
            const face = b.z + side * (b.d / 2 + .09);
            box(staticGroup, b.x, 1.7, face, 3.3, 3.4, .12, b.x > 0 ? 0x3d5369 : 0x735c49);
            for (let y = .4; y < 3.4; y += .35) box(staticGroup, b.x, y, face + side * .075, 3.15, .04, .03, 0x30383c);
            box(staticGroup, b.x, 3.55, face, 3.7, .18, .4, 0x656563);
        }
    }
    for (const r of RAMPS) {
        const staticGroup = object(`ramp:${RAMPS.indexOf(r)}`, { ramp: r });
        const x0 = r.x - r.w / 2, x1 = r.x + r.w / 2, z0 = r.z - r.d / 2, z1 = r.z + r.d / 2;
        const h = (x: number, z: number) => (0.5 + (r.axis === 'x' ? (x - r.x) / r.w : (z - r.z) / r.d) * r.sign) * r.h;
        const v = [x0, h(x0, z0), z0, x0, h(x0, z1), z1, x1, h(x1, z1), z1, x1, h(x1, z0), z0, x0, 0, z0, x0, 0, z1, x1, 0, z1, x1, 0, z0];
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
        geo.setIndex([0, 1, 2, 0, 2, 3, 4, 0, 3, 4, 3, 7, 1, 5, 6, 1, 6, 2, 4, 5, 1, 4, 1, 0, 3, 2, 6, 3, 6, 7]);
        geo.computeVertexNormals();
        const mesh = new THREE.Mesh(geo, material(r.color));
        mesh.receiveShadow = true;
        mesh.castShadow = true;
        staticGroup.add(mesh);
    }
    // Sparse angular paving fragments retain clean silhouettes and add scale to the yard.
    staticGroup = object('ground-paint', { decoration: 'paint' });
    for (let i = 0; i < 115; i++) {
        const x = ((i * 29.73) % 70) - 35, z = ((i * 17.39) % 70) - 35;
        if (BOXES.some(b => Math.abs(x - b.x) < b.w / 2 + .5 && Math.abs(z - b.z) < b.d / 2 + .5)) continue;
        if (RAMPS.some(r => Math.abs(x - r.x) < r.w / 2 && Math.abs(z - r.z) < r.d / 2)) continue;
        const chip = box(staticGroup, x, .003, z, .35 + (i % 4) * .2, .005, .18 + (i % 3) * .13, i % 2 ? 0x9c6c55 : 0xd49e7c);
        chip.rotation.y = i * 1.73;
    }
    // Painted lane markers and a plaza inset help players learn the three routes at a glance.
    for (const s of [-1, 1]) {
        box(staticGroup, s * 31, 0.007, 12 * s, 0.18, 0.013, 14, 0xe4dac0);
        box(staticGroup, s * 21, 0.01, -30 * s, 16, 0.02, 0.13, 0xe4dac0);
    }
    box(staticGroup, 0, 0.009, 21, 5, 0.018, 6, 0x96938a);
    for (const x of [-1, 1]) {
        staticGroup = boxGroups.get(BOXES[8])!;
        // Twenty micrometres of paint avoids coplanar faces without a ledge.
        box(staticGroup, x * 4.55, 4, 0, 0.17, .00004, 8, 0xe4b450);
        staticGroup = boxGroups.get(BOXES[9])!;
        box(staticGroup, x * 4.5, 4, -8, 0.13, .00004, 6, 0xe4b450);
    }
    // Small architectural accents stay geometric, just like the reference maps.
    for (const b of DETAIL_BOXES) {
        const roof = BUILDING_ROOFS.find(r => r.box === b), vent = ROOF_VENTS.find(v => v.body === b || v.cap === b);
        staticGroup = object(`detail:${DETAIL_BOXES.indexOf(b)}`, { collider: b, building: roof?.building ?? vent?.building });
        box(staticGroup, b.x, b.y, b.z, b.w, b.h, b.d, b.color);
        if (vent?.cap === b) {
            for (let n = 0; n < 4; n++) box(staticGroup, b.x - .7 + n * .45, b.y + b.h / 2 - .015 + .00002, b.z, .08, .03, 1.6, 0x30383c);
        }
    }
    for (let i = 0; i < 16; i++) {
        staticGroup = object(`skyline:${i}`, { decoration: 'skyline' });
        const x = (i % 8 - 3.5) * 15, z = i < 8 ? -48 : 49, h = 5 + (i * 7 % 9);
        box(staticGroup, x, h / 2, z, 10, h, 9, [0x797b7c, 0x9b8173, 0x969795, 0x687580][i % 4]);
        box(staticGroup, x, h + 0.12, z, 10.4, 0.25, 9.4, 0xb4b1a9);
    }
    // A fixed crane behind the boundary gives the industrial yard a recognisable skyline.
    staticGroup = object('crane', { decoration: 'skyline' });
    const steel = 0x655c4e, yellow = 0xb89a5f;
    for (const x of [-30.7, -29.3]) box(staticGroup, x, 10, -44, .22, 20, .22, steel);
    for (let y = 1; y < 20; y += 2) {
        const brace = box(staticGroup, -30, y, -44, 2.4, .13, .13, yellow);
        brace.rotation.z = (y % 4 === 1 ? 1 : -1) * .95;
    }
    box(staticGroup, -22, 19, -44, 24, .25, .8, steel);
    box(staticGroup, -22, 20.1, -44, 24, .18, .8, yellow);
    for (let x = -33; x < -10; x += 2) {
        const brace = box(staticGroup, x, 19.55, -44, 2.15, .1, .15, yellow);
        brace.rotation.z = .52;
    }
    box(staticGroup, -30, 17.7, -44, 2.6, 1.8, 2.2, yellow);
    box(staticGroup, -29.6, 17.8, -42.88, 1.5, .85, .04, 0x30383c);
    box(staticGroup, -12, 15.3, -44, .06, 7.2, .06, steel);
    box(staticGroup, -11.8, 11.75, -44, .46, .16, .12, steel);
    // The shared panel collider covers the bars, including their upper extent.
    for (const b of FENCE_BOXES) {
        staticGroup = object(`fence:${Math.sign(b.x)}`, { collider: b });
        for (let z = -30; z <= 30; z += 3) box(staticGroup, b.x, b.y, z, .12, b.h, .12, b.color);
        for (const y of [6.4, 7.6]) box(staticGroup, b.x, y, 0, .06, .06, 60, b.color);
        for (let z = -29.6; z < 29.6; z += .75) {
            const wire = box(staticGroup, b.x, b.y, z, .035, 1.6, .035, 0x969795);
            wire.rotation.x = .45;
        }
    }
    // Static folded pennants and broad wall flags, kept above playable sight lines.
    for (const z of [-13, 13]) {
        staticGroup = object(`pennants:${z}`, { decoration: 'fabric' });
        box(staticGroup, 0, 8.5, z, 26, .035, .035, 0x65503d);
        for (let x = -10; x <= 10; x += 2.5) {
            const flag = box(staticGroup, x, 8.05, z, .72, .9, .035, (x + 10) % 5 === 0 ? 0x3d5369 : 0xb3654c);
            flag.rotation.z = .12; flag.rotation.y = .16;
        }
    }
    for (const collider of BOXES.filter(b => b.kind === 'building' && b.w > 5)) {
        const b = visualBody(collider), staticGroup = boxGroups.get(collider)!;
        const z = b.z + b.d / 2 + .16;
        const y = Math.min(5.7, b.y + b.h / 2 - .55);
        box(staticGroup, b.x + 5.2, y, z, 1.4, 1.1, .055, b.x > 0 ? 0x3d5369 : 0xb3654c);
        box(staticGroup, b.x + 5.2, y, z + .035, 1.4, .2, .03, 0xd4bf84);
        box(staticGroup, b.x + 4.95, y, z + .035, .18, 1.1, .03, 0xd4bf84);
    }
    function facadeSign(b: MapBox, text: string, y: number, width: number, height: number, side: number, bg: string, fg?: string) {
        const body = visualBody(b);
        const faceOffset = b.kind === 'cover' ? .081 : y < 3.5 ? .181 : .01;
        sign(boxGroups.get(b)!, text, b.x, y, b.z + side * (body.d / 2 + faceOffset), width, height, side < 0 ? Math.PI : 0, bg, fg);
    }
    facadeSign(BOXES[4], 'SANDYARD', 5.65, 7.6, 1.4, 1, '#355b5a');
    facadeSign(BOXES[5], 'WAREHOUSE 02', 5.2, 7.5, 1.3, 1, '#3b5b5b');
    facadeSign(BOXES[7], 'A  →', 2.3, 3, 1.15, -1, '#a66348');
    facadeSign(BOXES[6], '←  B', 2.3, 3, 1.15, 1, '#426e74');
    facadeSign(BOXES[20], 'CARGO / 03', 1.65, 3.5, .65, 1, '#345559', '#e6dbc1');
    facadeSign(BOXES[15], '01', 5.65, 2.1, 1.25, 1, '#cbbb9b', '#f5edda');
    if (batch) {
        // Flatten ownership groups with world transforms intact. Textured signs
        // keep their own materials; all solid colours still share one draw call.
        staticGroup = new THREE.Group();
        scene.add(staticGroup);
        scene.updateMatrixWorld(true);
        for (const { group } of objects) {
            for (const mesh of [...group.children]) {
                if (mesh instanceof THREE.Mesh && (mesh.material as THREE.MeshBasicMaterial).map) scene.attach(mesh);
                else staticGroup.attach(mesh);
            }
            scene.remove(group);
        }
        batchMeshes(staticGroup);
    }
    return objects;
}
