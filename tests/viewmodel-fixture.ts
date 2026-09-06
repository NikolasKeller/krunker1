import * as THREE from 'three';
import { Viewmodel } from '../src/client/viewmodel';
import { WEAPONS } from '../src/shared/weapons';
import type { WeaponId } from '../src/shared/types';

export const VIEWMODEL_POSES = ['hip', 'aim', 'reload'] as const;
export type ViewmodelPose = typeof VIEWMODEL_POSES[number];

// Share the exact frozen poses between the HTML fixtures and scene-graph checks.
export function createViewmodelFixture(weapon: WeaponId, pose: ViewmodelPose) {
    const vm = new Viewmodel();
    vm.setWeapon(weapon);
    vm.update(1, 0, 0, false, 0, 1000, 0);
    // Freeze the sniper before the existing full-scope overlay replaces it.
    if (pose === 'aim') vm.update(WEAPONS[weapon].scopeTime / 1000 * (weapon === 'sniper' ? .65 : 1), 0, 0, true, 0, 1000, 0);
    if (pose === 'reload') vm.update(0, 0, 0, false, 1000 + WEAPONS[weapon].reload * .5, 1000, 0);
    return vm;
}

// No WebGL required. Count only drawable weapon geometry attached to the scene;
// an arm or muzzle flash alone must never satisfy this check.
export function assertVisibleWeapon(vm: Viewmodel) {
    if (vm.gun.parent !== vm.rig || vm.rig.parent !== vm.scene) throw new Error(`${vm.weapon}: weapon detached from scene`);
    vm.scene.updateMatrixWorld(true);
    vm.camera.updateMatrixWorld(true);
    let meshes = 0, triangles = 0, onscreenVertices = 0;
    const projected = new THREE.Vector3();
    const weapons = new Set<THREE.Object3D>();
    vm.gun.traverse(object => weapons.add(object));
    vm.scene.traverseVisible(object => {
        const mesh = object as THREE.Mesh;
        if (!weapons.has(object) || !mesh.isMesh || !vm.camera.layers.test(mesh.layers)) return;
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        if (!materials.some(material => material.visible && material.colorWrite && (!material.transparent || material.opacity > 0))) return;
        const position = mesh.geometry.getAttribute('position'), index = mesh.geometry.index;
        if (!position) return;
        const { start, count } = mesh.geometry.drawRange;
        const end = Math.min(index?.count ?? position.count, start + count);
        if (end - start < 3) return;
        meshes++;
        triangles += Math.floor((end - start) / 3);
        for (let i = start; i < end; i++) {
            projected.fromBufferAttribute(position, index ? index.getX(i) : i).applyMatrix4(mesh.matrixWorld).project(vm.camera);
            if (![projected.x, projected.y, projected.z].every(Number.isFinite)) throw new Error(`${vm.weapon}: non-finite weapon geometry`);
            if (Math.max(Math.abs(projected.x), Math.abs(projected.y), Math.abs(projected.z)) < 1) onscreenVertices++;
        }
    });
    if (!meshes || !triangles || !onscreenVertices) throw new Error(`${vm.weapon}: no visible weapon mesh in camera (${meshes} meshes, ${triangles} triangles, ${onscreenVertices} onscreen vertices)`);
    return { meshes, triangles, onscreenVertices };
}
