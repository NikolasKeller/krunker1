import * as THREE from 'three';
import type { MapDefinition } from '../shared/map';
import type { MapObject } from './map-renderer';
import { batchMeshes, box, material } from './models';

export function buildThemedMap(scene: THREE.Scene, map: MapDefinition, batch: boolean): MapObject[] {
    const objects: MapObject[] = [];
    const inlayMaterials = new Map<string, THREE.MeshLambertMaterial>();
    const inlay = (mesh: THREE.Mesh, layer = 1) => {
        const color = (mesh.material as THREE.MeshLambertMaterial).color.getHex();
        const key = `${color}:${layer}`;
        if (!inlayMaterials.has(key)) inlayMaterials.set(key, new THREE.MeshLambertMaterial({ color, flatShading: true, polygonOffset: true, polygonOffsetFactor: -layer, polygonOffsetUnits: -2 * layer }));
        mesh.material = inlayMaterials.get(key)!;
    };
    const object = (id: string, physics: Omit<MapObject, 'id' | 'group'>) => {
        const group = new THREE.Group(); group.name = `${map.id}:${id}`;
        objects.push({ id: group.name, group, ...physics }); scene.add(group); return group;
    };
    const ground = object('floor', { decoration: 'ground' });
    box(ground, 0, -.25, 0, 78, .5, 78, map.palette.floor);
    for (const [i, b] of map.boxes.entries()) {
        const group = object(`solid:${i}`, { collider: b });
        const mesh: THREE.Mesh = box(group, b.x, b.y, b.z, b.w, b.h, b.d, b.color);
        if (b.surface === 'glass') {
            mesh.material = new THREE.MeshBasicMaterial({ color: b.color, transparent: true, opacity: .21, depthWrite: false });
            mesh.castShadow = false;
        }
        if (b.surface === 'light') {
            mesh.material = new THREE.MeshBasicMaterial({ color: b.color });
            const light = new THREE.PointLight(b.color, map.id === 'catacomb' ? 35 : 18, 16, 1.3);
            light.position.set(b.x, b.y + .6, b.z); scene.add(light);
        }
        // Flush face inlays stay inside the solid's exact footprint. Full-size
        // base geometry ensures both faces of each collider are visibly occupied.
        const foliage = map.id === 'wildroot' && [0x72583e, 0x3d8652, 0x72af59, 0x378550, 0x66aa51].includes(b.color);
        if (!b.surface && !foliage && b.h > 2 && b.w >= 2 && b.d >= 2) {
            // Face details lie flush within the full solid mesh. They add the
            // theme's material language without moving a single collision face.
            for (const axis of ['x', 'z'] as const) for (const side of [-1, 1]) {
                const alongX = axis === 'z', length = alongX ? b.w : b.d;
                const inset = side * ((alongX ? b.d : b.w) / 2 - .008);
                const tile = (offset: number, y: number, w: number, h: number, color: number, layer = 1) =>
                    inlay(box(group, b.x + (alongX ? offset : inset), y, b.z + (alongX ? inset : offset), alongX ? w : .016, h, alongX ? .016 : w, color), layer);
                if (map.id === 'catacomb' || map.id === 'wildroot') {
                    for (let row = 0; row < Math.floor(b.h / .85); row++) {
                        const y = b.y - b.h / 2 + .42 + row * .85;
                        for (let column = 0; column < Math.floor(length / 1.6); column++) {
                            const offset = -length / 2 + .8 + column * 1.6;
                            tile(offset, y, 1.45, .73, map.id === 'catacomb' ? (row + column) % 3 ? 0x8d819a : 0x6b607c : (row + column) % 3 ? b.color : 0x99a174);
                        }
                    }
                    if (map.id === 'wildroot') for (let n = 0; n < Math.floor(length / 2); n++)
                        tile(-length / 2 + 1 + n * 2, b.y + b.h / 2 - .3 - n % 3 * .16, .7, .6, 0x4f914c, 2);
                } else {
                    for (let n = 0; n < Math.floor(length / 3); n++) {
                        const offset = -length / 2 + 1.5 + n * 3;
                        tile(offset, b.y, 2.75, Math.min(b.h - .4, 3.8), map.id === 'orbital' ? 0x526882 : 0x347782);
                        tile(offset, b.y + Math.min(b.h / 2 - .15, 1.5), 2.3, .07, map.id === 'orbital' ? 0xa6ecf2 : 0x85c7b8, 2);
                        if (b.kind === 'cover' || b.kind === 'building') {
                            tile(offset, b.y, 1.6, .7, 0x233d51, 2);
                            tile(offset - .4, b.y, .5, .05, 0xb9edc5, 3);
                        }
                    }
                }
            }
        }
    }
    for (const [i, r] of map.ramps.entries()) {
        const group = object(`ramp:${i}`, { ramp: r });
        const x0 = r.x - r.w / 2, x1 = r.x + r.w / 2, z0 = r.z - r.d / 2, z1 = r.z + r.d / 2;
        const h = (x: number, z: number) => (.5 + (r.axis === 'x' ? (x - r.x) / r.w : (z - r.z) / r.d) * r.sign) * r.h;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute([x0,h(x0,z0),z0, x0,h(x0,z1),z1, x1,h(x1,z1),z1, x1,h(x1,z0),z0, x0,0,z0, x0,0,z1, x1,0,z1, x1,0,z0], 3));
        geo.setIndex([0,1,2,0,2,3,4,0,3,4,3,7,1,5,6,1,6,2,4,5,1,4,1,0,3,2,6,3,6,7]); geo.computeVertexNormals();
        const mesh = new THREE.Mesh(geo, material(r.color)); mesh.castShadow = mesh.receiveShadow = true; group.add(mesh);
    }
    const paint = object('floor-markings', { decoration: 'paint' });
    for (const side of [-1, 1]) {
        for (const x of [-26, -13, 0, 13, 26]) box(paint, x, .009, side * 33, 5, .012, .25, side < 0 ? 0xf09580 : 0x8cc9f1);
    }
    if (map.id === 'orbital' || map.id === 'abyss') {
        for (const x of [-31, 31]) for (let z = -25; z <= 25; z += 5) box(paint, x, .012, z, .18, .012, 2, 0xa6ece0);
    }
    if (map.id === 'abyss' || map.id === 'wildroot') {
        // Flat caustic/canopy pools add readable light patterns without physical
        // clutter. Their vertical extent is audited against the shared floor.
        for (let i = 0; i < 85; i++) {
            const x = -34 + (i * 17.13 % 68), z = -25 + (i * 11.7 % 50);
            const mesh = box(paint, x, .014, z, map.id === 'abyss' ? 2.3 : 3.5, .012, .25 + i % 3 * .2, map.id === 'abyss' ? 0x64b6af : 0xc5c884);
            mesh.rotation.y = i * .83;
        }
    }
    if (map.id === 'orbital') {
        const planet = object('planet', { decoration: 'skyline' });
        const globe = new THREE.Mesh(new THREE.IcosahedronGeometry(23, 2), material(0x649bc5));
        globe.position.set(86, 18, -12); planet.add(globe);
        const moon = new THREE.Mesh(new THREE.IcosahedronGeometry(8, 1), material(0xd8baa4)); moon.position.set(-76, 26, 15); planet.add(moon);
        // Separate ownership avoids an enormous AABB spanning the playable arena.
        planet.remove(moon); object('moon', { decoration: 'skyline' }).add(moon);
        for (const side of [-1, 1]) {
            const stars = object(`stars:${side}`, { decoration: 'skyline' });
            for (let i = 0; i < 100; i++) {
                const star: THREE.Mesh = box(stars, side * (100 + i % 4 * 9), -5 + (i * 7.17 % 95), -100 + (i * 23.79 % 200), .3 + i % 3 * .2, .3 + i % 3 * .2, .3, 0xddeeff);
                star.material = new THREE.MeshBasicMaterial({ color: i % 4 ? 0xddeeff : 0xa6b6ff });
            }
        }
    }
    for (const side of [-1, 1]) {
        if (map.id === 'abyss' || map.id === 'wildroot') {
            const landscape = object(`landscape:${side}`, { decoration: 'skyline' });
            box(landscape, side * 57, -1, 0, 30, 2, 100, map.id === 'abyss' ? 0x284d67 : 0x668757);
            for (let i = 0; i < 16; i++) {
                const x = side * (45 + i % 4 * 5), z = -42 + i * 5.7, h = 7 + i % 5 * 2;
                box(landscape, x, h / 2, z, 1.1, h, 1.1, map.id === 'abyss' ? 0x3caa9e : 0x5c6943);
                if (map.id === 'abyss') {
                    for (let branch = 0; branch < 3; branch++) {
                        const frond = box(landscape, x + (branch % 2 ? -.9 : .9), h * (.4 + branch * .2), z, 2.7, .3, .6, branch % 2 ? 0x57c5b0 : 0x48a69e);
                        frond.rotation.z = (branch % 2 ? -1 : 1) * .55;
                    }
                    const rock = new THREE.Mesh(new THREE.IcosahedronGeometry(2.8, 0), material(0x3f6e85));
                    rock.position.set(x + 2, 0, z); rock.scale.y = .6; landscape.add(rock);
                } else {
                    box(landscape, x, h, z, 8, 3, 8, 0x427f49);
                    box(landscape, x, h + 2, z, 5, 2, 5, 0x6da653);
                }
            }
        }
    }
    if (map.id === 'wildroot') {
        for (const [x, z] of [[-9, -7], [15, 9], [-23, 5]]) {
            const shaft = new THREE.SpotLight(0xffe4a0, 100, 45, .22, .6, 1);
            shaft.position.set(x - 9, 24, z - 4); shaft.target.position.set(x, 0, z);
            scene.add(shaft, shaft.target);
        }
    }
    if (batch) {
        const solids = new THREE.Group(), emitters = new THREE.Group(), inlays = [new THREE.Group(), new THREE.Group(), new THREE.Group()]; scene.add(solids, emitters, ...inlays); scene.updateMatrixWorld(true);
        for (const { group } of objects) {
            for (const child of [...group.children]) {
                const mat = (child as THREE.Mesh).material;
                // Glass and emitters retain their material; other geometry uses
                // the same production batching path as the existing yard.
                if (mat instanceof THREE.MeshBasicMaterial && mat.transparent) scene.attach(child);
                else if (mat instanceof THREE.MeshBasicMaterial) emitters.attach(child);
                else if (mat instanceof THREE.Material && mat.polygonOffset) inlays[-mat.polygonOffsetFactor - 1].attach(child);
                else solids.attach(child);
            }
            scene.remove(group);
        }
        batchMeshes(solids);
        // Hundreds of stars share one emissive draw; windows retain blending.
        batchMeshes(emitters);
        for (const mesh of emitters.children) { (mesh as THREE.Mesh).material = new THREE.MeshBasicMaterial({ vertexColors: true }); mesh.castShadow = false; }
        for (const [index, group] of inlays.entries()) {
            batchMeshes(group);
            for (const mesh of group.children) {
                const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, polygonOffset: true, polygonOffsetFactor: -index - 1, polygonOffsetUnits: -2 * (index + 1) });
                mat.userData.mapOwned = true; (mesh as THREE.Mesh).material = mat;
                mesh.castShadow = false;
            }
        }
    }
    return objects;
}
