import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { BOXES, SOLID_BOXES } from '../src/shared/map';
import { auditMap, colliderBounds, headlessMap } from './map-geometry';

test('every rendered map object fits its real collider in world space, including attached details and roofs', () => {
    const { scene, objects } = headlessMap();
    const failures = auditMap(scene, objects);
    assert.deepEqual(failures, [], `Rendered geometry exceeds collision (metres):\n${failures.join('\n')}`);
    console.log(`Map geometry: ${objects.length} objects, ${SOLID_BOXES.length} solid boxes; tolerance 0.0001 m`);
});

test('the audit rejects unsupported rotated trim, upper walls, unowned props and roofs over empty ground', () => {
    const { scene, objects } = headlessMap();
    const building = objects.find(o => o.collider === BOXES[4])!;
    const detail = new THREE.Mesh(new THREE.BoxGeometry(.1, .1, .1));
    detail.rotation.z = Math.PI / 4;
    detail.position.set(-12.06, 1, -13);
    building.group.add(detail);
    assert.ok(auditMap(scene, objects).some(f => f.startsWith(building.id)), 'rotated corners escape despite their centre being inside');
    detail.rotation.set(0, 0, 0);
    detail.position.set(-19, 7.1, -13);
    assert.ok(auditMap(scene, objects).some(f => f.startsWith(building.id)), 'a roof collider cannot hide unsupported upper wall geometry');
    building.group.remove(detail);
    scene.add(detail);
    assert.ok(auditMap(scene, objects).some(f => f.startsWith('unowned mesh:')), 'new raw meshes cannot silently bypass the audit');
    scene.remove(detail);

    const roof = objects.find(o => o.building === BOXES[4] && o.collider !== BOXES[4])!;
    const collider = roof.collider!, oldWidth = collider.w;
    const mesh = roof.group.children[0] as THREE.Mesh, oldScale = mesh.scale.x;
    try {
        collider.w += .35; mesh.scale.x += .35;
        const failures = auditMap(scene, objects);
        assert.ok(!failures.some(f => f.startsWith(`${roof.id}:`)), 'roof geometry and its own collider still match');
        assert.ok(failures.some(f => f.includes('unsupported footprint')), 'the whole building footprint must also be solid below the roof');
    } finally { collider.w = oldWidth; mesh.scale.x = oldScale; }
    assert.deepEqual(auditMap(scene, objects), []);
});

function renderedVertices(scene: THREE.Scene, textured: boolean) {
    const vertices: number[] = [];
    scene.updateMatrixWorld(true);
    scene.traverse(mesh => {
        if (!(mesh instanceof THREE.Mesh) || Boolean((mesh.material as THREE.MeshBasicMaterial).map) !== textured) return;
        const position = mesh.geometry.getAttribute('position'), index = mesh.geometry.index;
        for (let i = 0; i < (index?.count ?? position.count); i++) {
            const p = new THREE.Vector3().fromBufferAttribute(position, index ? index.getX(i) : i).applyMatrix4(mesh.matrixWorld);
            vertices.push(...p.toArray().map(Math.fround));
        }
    });
    return vertices;
}
test('production batching preserves every audited triangle and textured sign in world space', () => {
    const audit = headlessMap(), production = headlessMap(true);
    for (const textured of [false, true]) {
        assert.deepEqual(renderedVertices(production.scene, textured), renderedVertices(audit.scene, textured));
    }
});

test('all six facade signs remain visible in front of their buildings and containers', () => {
    const { scene, objects } = headlessMap();
    let signs = 0;
    for (const { group, collider } of objects) for (const child of group.children) {
        if (!(child instanceof THREE.Mesh) || !(child.material as THREE.MeshBasicMaterial).map) continue;
        signs++;
        const center = child.getWorldPosition(new THREE.Vector3());
        const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(child.getWorldQuaternion(new THREE.Quaternion()));
        const ray = new THREE.Raycaster(center.clone().addScaledVector(normal, .5), normal.clone().negate(), 0, 1);
        assert.equal(ray.intersectObjects(scene.children, true)[0]?.object, child, `${group.name}: sign hidden behind facade trim`);
        assert.ok(colliderBounds(collider!).containsPoint(center));
    }
    assert.equal(signs, 6);
});
