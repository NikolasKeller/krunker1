import * as THREE from 'three';
import { buildMap, type MapObject } from '../src/client/map-renderer';
import { BOXES, MAP_SIZE, SOLID_BOXES, RAMPS, type MapBox, SANDYARD } from '../src/shared/map';

export const BOUNDS_TOLERANCE = 1e-4;
export function headlessMap(batch = false, map = SANDYARD) {
    // Text drawing is irrelevant to geometry; PlaneGeometry still has its real
    // size and world transform. No browser, WebGL context or DOM emulator.
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'document', { configurable: true, value: {
        createElement: () => ({ width: 0, height: 0, getContext: () => ({ fillRect() {}, fillText() {} }) }),
    } });
    try {
        const scene = new THREE.Scene();
        const objects = buildMap(scene, { batch, map });
        scene.updateMatrixWorld(true);
        return { scene, objects };
    } finally {
        if (previous) Object.defineProperty(globalThis, 'document', previous);
        else Reflect.deleteProperty(globalThis, 'document');
    }
}
export function colliderBounds(b: MapBox) {
    return new THREE.Box3(new THREE.Vector3(b.x - b.w / 2, b.y - b.h / 2, b.z - b.d / 2),
        new THREE.Vector3(b.x + b.w / 2, b.y + b.h / 2, b.z + b.d / 2));
}
export function offsets(visible: THREE.Box3, solid: THREE.Box3) {
    return Object.fromEntries((['x', 'y', 'z'] as const).flatMap(axis => [
        [`-${axis}`, Math.max(0, solid.min[axis] - visible.min[axis])],
        [`+${axis}`, Math.max(0, visible.max[axis] - solid.max[axis])],
    ]).filter(([, n]) => Number(n) > BOUNDS_TOLERANCE));
}
export function boundsText(b: THREE.Box3) {
    return `[${b.min.toArray().map(n => n.toFixed(4))}]..[${b.max.toArray().map(n => n.toFixed(4))}]`;
}
export function buildingBounds(objects: MapObject[], map = SANDYARD) {
    return (map.id === 'sandyard' ? BOXES : []).filter(b => b.kind === 'building').map(building => {
        const rendered = new THREE.Box3(), solid = new THREE.Box3();
        for (const o of objects.filter(o => o.building === building)) {
            rendered.union(new THREE.Box3().setFromObject(o.group, true));
            if (o.collider) solid.union(colliderBounds(o.collider));
        }
        return { building, rendered, solid };
    });
}
export function auditMap(scene: THREE.Scene, objects: MapObject[], map = SANDYARD) {
    const { boxes: SOLID_BOXES, ramps: RAMPS, size: MAP_SIZE } = map;
    scene.updateMatrixWorld(true);
    const failures: string[] = [], owned = new Set<THREE.Mesh>();
    for (const o of objects) {
        const bounds = new THREE.Box3().setFromObject(o.group, true);
        if (bounds.isEmpty()) failures.push(`${o.id}: empty object`);
        const meshes: THREE.Mesh[] = [];
        o.group.traverse(mesh => {
            if (!(mesh instanceof THREE.Mesh)) return;
            if (owned.has(mesh)) failures.push(`${o.id}: mesh owned twice`);
            owned.add(mesh); meshes.push(mesh);
        });
        if (o.collider) {
            if (!SOLID_BOXES.includes(o.collider)) failures.push(`${o.id}: collider absent from SOLID_BOXES`);
            const solid = colliderBounds(o.collider), outside = offsets(bounds, solid);
            if (map.id !== 'sandyard' && (bounds.min.distanceTo(solid.min) > BOUNDS_TOLERANCE || bounds.max.distanceTo(solid.max) > BOUNDS_TOLERANCE)) failures.push(`${o.id}: collider does not exactly match visible bounds`);
            if (Object.keys(outside).length) failures.push(`${o.id}: rendered ${boundsText(bounds)}, collider ${boundsText(solid)}, offsets ${JSON.stringify(outside)}`);
        } else if (o.ramp) {
            const r = o.ramp;
            if (!RAMPS.includes(r)) failures.push(`${o.id}: absent from RAMPS`);
            // An AABB alone would accept a box filling the empty air above the
            // incline. Every actual transformed vertex must lie in the wedge.
            for (const mesh of meshes) {
                const position = mesh.geometry.getAttribute('position');
                for (let i = 0; i < position.count; i++) {
                    const p = new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
                    const top = (.5 + (p[r.axis] - r[r.axis]) / (r.axis === 'x' ? r.w : r.d) * r.sign) * r.h;
                    if (Math.abs(p.x - r.x) > r.w / 2 + BOUNDS_TOLERANCE || Math.abs(p.z - r.z) > r.d / 2 + BOUNDS_TOLERANCE ||
                        p.y < -BOUNDS_TOLERANCE || p.y > top + BOUNDS_TOLERANCE) {
                        failures.push(`${o.id}: vertex ${p.toArray()} outside collision wedge`); break;
                    }
                }
            }
        } else if (o.decoration === 'ground') {
            if (bounds.max.y > BOUNDS_TOLERANCE) failures.push(`${o.id}: ground protrudes above collision floor`);
        } else if (o.decoration === 'paint') {
            if (bounds.min.y < -BOUNDS_TOLERANCE || bounds.max.y > .025) failures.push(`${o.id}: paint reads as a raised obstacle`);
        } else if (o.decoration === 'skyline') {
            const edge = MAP_SIZE / 2;
            if (bounds.max.x > -edge && bounds.min.x < edge && bounds.max.z > -edge && bounds.min.z < edge)
                failures.push(`${o.id}: solid-looking scenery enters playable bounds`);
        } else if (o.decoration === 'fabric') {
            if (bounds.min.y < 7.5 || bounds.max.z - bounds.min.z > .2)
                failures.push(`${o.id}: pennants must remain thin fabric above the lanes`);
        } else failures.push(`${o.id}: unclassified geometry`);
    }
    scene.traverse(mesh => {
        if (mesh instanceof THREE.Mesh && !owned.has(mesh)) failures.push(`unowned mesh: ${mesh.name || mesh.uuid}`);
    });
    for (const b of SOLID_BOXES) if (!objects.some(o => o.collider === b)) failures.push(`unrendered collider: ${JSON.stringify(b)}`);
    for (const r of RAMPS) if (!objects.some(o => o.ramp === r)) failures.push(`unrendered ramp: ${JSON.stringify(r)}`);
    for (const { building, rendered, solid } of buildingBounds(objects, map)) {
        // A roof can have its own correct collider yet still project over empty
        // ground. The complete visible building footprint must be solid below.
        const footprint = colliderBounds(building);
        footprint.max.y = solid.max.y;
        const outside = offsets(rendered, footprint);
        if (Object.keys(outside).length) failures.push(`building at (${building.x},${building.z}): unsupported footprint/height ${JSON.stringify(outside)}`);
    }
    // Sweep the entire inner shell, including seams and corners. A union of
    // intervals detects even sub-millimetre gaps; sampling rays would miss them.
    for (const axis of ['x', 'z'] as const) for (const side of [-1, 1]) {
        const cross = axis === 'x' ? 'z' : 'x', edge = side * (map.size / 2 - 1);
        // Partition at EVERY vertical face as well as the required shell top.
        // A tiny slit between a window and lintel must fail just like a doorway.
        const heights = [...new Set([0, map.boundaryHeight, ...map.boxes.flatMap(b => [b.y - b.h / 2, b.y + b.h / 2])])]
            .filter(y => y >= 0 && y <= map.boundaryHeight).sort((a, b) => a - b);
        for (let band = 1; band < heights.length; band++) {
            const y = (heights[band - 1] + heights[band]) / 2;
            const spans = map.boxes.filter(b => {
                const half = (axis === 'x' ? b.w : b.d) / 2;
                return Math.abs(edge - b[axis]) <= half + BOUNDS_TOLERANCE && y >= b.y - b.h / 2 && y <= b.y + b.h / 2;
            }).map(b => [b[cross] - (cross === 'x' ? b.w : b.d) / 2, b[cross] + (cross === 'x' ? b.w : b.d) / 2]).sort((a, b) => a[0] - b[0]);
            let covered = -map.size / 2 + 1;
            for (const [lo, hi] of spans) {
                if (lo > covered + BOUNDS_TOLERANCE) break;
                covered = Math.max(covered, hi);
            }
            if (covered < map.size / 2 - 1 - BOUNDS_TOLERANCE) failures.push(`outer shell gap: ${axis}/${side}, y=${y}, after ${covered}`);
        }
    }
    return failures;
}
