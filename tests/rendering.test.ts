import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildMap } from '../src/client/map-renderer';
import { animateCharacter, makeCharacter, makeGun } from '../src/client/models';
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
        assert.ok(meshes < 65, `${meshes} static draw calls`);
        assert.ok(triangles > 1000 && triangles < 30000, `${triangles} triangles`);
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
