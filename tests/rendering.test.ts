import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildMap } from '../src/client/map-renderer';
import { animateCharacter, makeCharacter, makeGun } from '../src/client/models';
import { orientCamera } from '../src/client/camera';
import { direction } from '../src/shared/math';
import { CLASS_IDS, WEAPONS } from '../src/shared/weapons';
import type { WeaponId } from '../src/shared/types';
test('map geometry builds without WebGL, merges correctly, and has walkable visible ramps', () => {
    // Only map-sign text needs a DOM canvas; this fixture does not emulate or launch a browser.
    const old = globalThis.document;
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => ({ width: 0, height: 0, getContext: () => ({ fillRect() { }, fillText() { } }) }) } });
    try {
        const scene = new THREE.Scene();
        buildMap(scene);
        scene.updateMatrixWorld(true);
        let meshes = 0, triangles = 0;
        scene.traverse(o => { if (o instanceof THREE.Mesh) {
            meshes++;
            const p = o.geometry.getAttribute('position');
            for (let i = 0; i < p.array.length; i++)
                assert.ok(Number.isFinite(p.array[i]));
            triangles += (o.geometry.index?.count ?? p.count) / 3;
        } });
        assert.ok(meshes <= 10, `${meshes} static draw calls: props must stay batched`);
        assert.ok(triangles > 1000 && triangles < 18000, `${triangles} triangles`);
        const ray = new THREE.Raycaster(new THREE.Vector3(-10, 10, 0), new THREE.Vector3(0, -1, 0));
        const hit = ray.intersectObjects(scene.children, true)[0];
        assert.ok(hit);
        assert.ok(Math.abs(hit.point.y - 2) < 0.05, `visible ramp top ${hit.point.y}`);
        console.log(`Static map: ${meshes} meshes, ${triangles} triangles`);
    }
    finally {
        Object.defineProperty(globalThis, 'document', { configurable: true, value: old });
    }
});
test('all weapon models and animated class silhouettes have finite, nonempty geometry', () => {
    for (const id of Object.keys(WEAPONS) as WeaponId[]) {
        const g = makeGun(id), bounds = new THREE.Box3().setFromObject(g);
        assert.equal(bounds.isEmpty(), false);
        assert.ok(bounds.max.z > bounds.min.z);
        assert.ok(g.children.length <= 8, `${id}: ${g.children.length} draw calls`);
    }
    for (const id of CLASS_IDS) {
        const c = makeCharacter(id, 0x7799aa);
        for (const speed of [0, 10, 25])
            for (const slide of [0, .5]) {
                animateCharacter(c, speed, 2.5, .5, slide);
                c.group.updateMatrixWorld(true);
                const bounds = new THREE.Box3().setFromObject(c.group);
                assert.ok(Number.isFinite(bounds.min.x + bounds.max.y));
                assert.ok(bounds.max.y > 1 && bounds.max.y < 2.1);
            }
    }
});

test('mouse camera direction matches authoritative hitscan at every pitch and yaw', () => {
    const camera = new THREE.PerspectiveCamera();
    for (const yaw of [-2.8, -1, 0, 1, 2.8]) for (const pitch of [-1.3, -.4, 0, .4, 1.3]) {
        orientCamera(camera, yaw, pitch);
        const forward = camera.getWorldDirection(new THREE.Vector3());
        const shot = direction(yaw, pitch);
        assert.ok(forward.distanceTo(new THREE.Vector3(shot.x, shot.y, shot.z)) < 1e-10);
        camera.updateMatrixWorld(true);
        const projected = new THREE.Vector3(shot.x, shot.y, shot.z).multiplyScalar(10).project(camera);
        assert.ok(Math.abs(projected.x) < 1e-8 && Math.abs(projected.y) < 1e-8, 'hitscan lands at the crosshair');
    }
});
test('a full room uses at most six meshes per remote character with preserved vertex colours', () => {
    let meshes = 0;
    for (let i = 0; i < 16; i++) {
        const c = makeCharacter(CLASS_IDS[i % 4], i % 2 ? 0x599fb6 : 0xc66d58);
        c.group.traverse(o => { if (o instanceof THREE.Mesh) { meshes++; assert.ok(o.geometry.getAttribute('color')); } });
    }
    assert.ok(meshes <= 96, `${meshes} remote character meshes`);
    console.log(`16 remote characters: ${meshes} meshes`);
});
