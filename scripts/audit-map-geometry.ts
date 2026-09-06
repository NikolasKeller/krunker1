import { MAPS } from '../src/shared/map';
import { auditMap, boundsText, buildingBounds, colliderBounds, headlessMap, offsets } from '../tests/map-geometry';
import * as THREE from 'three';

let total = 0;
for (const map of MAPS) {
console.log(`\n=== ${map.name} ===`);
const { scene, objects } = headlessMap(false, map);
for (const { building, rendered, solid } of buildingBounds(objects, map)) {
    console.log(`Complete building (${building.x},${building.z}): rendered ${boundsText(rendered)}, colliders ${boundsText(solid)}, offsets ${JSON.stringify(offsets(rendered, solid))}`);
}
for (const o of objects) {
    const bounds = new THREE.Box3().setFromObject(o.group, true);
    console.log(`${o.id}: rendered ${boundsText(bounds)}${o.collider ? ` collider ${boundsText(colliderBounds(o.collider))}` : ` ${o.ramp ? 'ramp' : o.decoration}`}`);
}
const failures = auditMap(scene, objects, map);
console.log(`\n${objects.length} objects, ${failures.length} mismatches (metres):`);
for (const failure of failures) console.log(failure);
total += failures.length;
}
process.exitCode = total ? 1 : 0;
