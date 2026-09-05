import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { ClassId, WeaponId } from '../shared/types';
import { CLASSES } from '../shared/weapons';
const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
const materials = new Map<number, THREE.MeshLambertMaterial>();
export function material(color: number) { if (!materials.has(color))
    materials.set(color, new THREE.MeshLambertMaterial({ color, flatShading: true })); return materials.get(color)!; }
export function box(parent: THREE.Object3D, x: number, y: number, z: number, w: number, h: number, d: number, color: number) { const mesh = new THREE.Mesh(boxGeometry, material(color)); mesh.position.set(x, y, z); mesh.scale.set(w, h, d); mesh.castShadow = true; mesh.receiveShadow = true; parent.add(mesh); return mesh; }
const gunTemplates = new Map<WeaponId, THREE.Group>();
const vertexMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
// One draw per animated limb/gun; retain the original flat palette as vertex colours.
export function batchMeshes(group: THREE.Group) {
    const geometries: THREE.BufferGeometry[] = [];
    for (const child of [...group.children]) {
        if (!(child instanceof THREE.Mesh)) continue;
        child.updateMatrix();
        const geo = (child.geometry.index ? child.geometry.toNonIndexed() : child.geometry.clone()).applyMatrix4(child.matrix);
        // Batched solid-colour meshes never sample textures; ramps need no UV attribute.
        geo.deleteAttribute('uv');
        const color = (child.material as THREE.MeshLambertMaterial).color;
        const values = new Float32Array(geo.getAttribute('position').count * 3);
        for (let i = 0; i < values.length; i += 3) { values[i] = color.r; values[i + 1] = color.g; values[i + 2] = color.b; }
        geo.setAttribute('color', new THREE.BufferAttribute(values, 3));
        geometries.push(geo);
        group.remove(child);
    }
    if (geometries.length) {
        const merged = mergeGeometries(geometries);
        geometries.forEach(g => g.dispose());
        if (merged) {
            const mesh = new THREE.Mesh(merged, vertexMaterial);
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            group.add(mesh);
        }
    }
    return group;
}
function finishGun(g: THREE.Group, id: WeaponId) { batchMeshes(g); gunTemplates.set(id, g); return g.clone(); }
export function makeGun(id: WeaponId): THREE.Group {
    if (gunTemplates.has(id))
        return gunTemplates.get(id)!.clone();
    const g = new THREE.Group(), dark = id === 'sniper' ? 0x404449 : 0x272a2b, black = id === 'sniper' ? 0x292c30 : 0x15191a, metal = 0x69716e, wood = 0x8e633d, stock = id === 'sniper' ? 0x737858 : wood;
    if (id === 'knife') {
        box(g, 0, 0, 0.14, 0.09, 0.1, 0.28, black);
        box(g, 0, 0, -0.22, 0.04, 0.12, 0.48, 0xa8b2b1);
        box(g, 0, 0, -0.005, 0.08, 0.24, 0.035, metal);
        return finishGun(g, id);
    }
    if (id === 'pistol') {
        box(g, 0, 0, -0.09, 0.13, 0.16, 0.5, metal);
        box(g, 0, -0.16, 0.07, 0.12, 0.27, 0.17, black).rotation.x = -0.2;
        box(g, 0, 0.1, -0.28, 0.025, 0.045, 0.04, black);
        box(g, 0, 0, -0.355, 0.065, 0.07, 0.04, black);
        return finishGun(g, id);
    }
    const sniper = id === 'sniper', shotgun = id === 'shotgun', smg = id === 'smg';
    box(g, 0, 0, sniper ? 0.38 : 0.43, sniper ? 0.12 : 0.16, sniper ? 0.16 : 0.22, sniper ? 0.42 : 0.49, stock);
    box(g, 0, -0.035, sniper ? 0.61 : 0.67, sniper ? 0.14 : 0.23, sniper ? 0.23 : 0.3, 0.075, black);
    box(g, 0, 0.015, 0, sniper ? 0.17 : 0.19, sniper ? 0.17 : 0.22, 0.52, dark);
    box(g, 0, -0.20, 0.15, 0.13, 0.27, 0.16, black).rotation.x = -0.28;
    if (!shotgun && !sniper) {
        box(g, 0, -0.235, -0.11, 0.14, smg ? 0.36 : 0.29, 0.19, dark).rotation.x = smg ? 0 : -0.25;
        box(g, 0, -0.35, -0.14, 0.145, 0.05, 0.20, metal);
    }
    box(g, 0, -0.15, 0.02, 0.15, 0.035, 0.19, black);
    box(g, 0, -0.10, -0.075, 0.15, 0.12, 0.035, black);
    box(g, 0, 0.015, -0.39, shotgun ? 0.23 : sniper ? 0.14 : 0.17, sniper ? 0.13 : 0.18, 0.40, shotgun ? wood : sniper ? stock : wood);
    const length = sniper ? 0.65 : smg ? 0.19 : 0.43;
    if (shotgun) {
        for (const x of [-0.072, 0.072]) {
            box(g, x, 0.065, -0.75, 0.095, 0.095, 0.53, metal);
            box(g, x, 0.065, -1.02, 0.072, 0.07, 0.01, black);
        }
    }
    else {
        box(g, 0, 0.045, -0.59 - length / 2, 0.075, 0.075, length, metal);
        box(g, 0, 0.045, -0.59 - length, 0.11, 0.11, 0.08, black);
    }
    if (sniper) {
        // Separated scope rings leave daylight between the optic and the slim receiver.
        for (const z of [-0.25, 0.08]) box(g, 0, 0.16, z, 0.08, 0.15, 0.065, metal);
        box(g, 0, 0.29, -0.09, 0.125, 0.125, 0.61, dark);
        for (const z of [-0.41, 0.23]) {
            const m = new THREE.Mesh(new THREE.CylinderGeometry(0.115, 0.115, 0.13, 10), material(dark));
            m.rotation.x = Math.PI / 2;
            m.position.set(0, 0.29, z);
            g.add(m);
        }
        for (const z of [-0.48, 0.3]) {
            const lens = new THREE.Mesh(new THREE.CylinderGeometry(.088, .088, .008, 10), material(z > 0 ? 0x263b43 : 0x68848a));
            lens.rotation.x = Math.PI / 2; lens.position.set(0, .29, z); g.add(lens);
        }
        box(g, 0, 0.38, -0.12, 0.075, 0.065, 0.085, metal);
        box(g, 0.13, 0.08, 0.11, 0.16, 0.055, 0.065, metal);
    }
    else {
        box(g, 0, 0.165, -0.12, 0.11, 0.08, 0.11, black);
        box(g, 0, 0.17, smg ? -0.62 : -0.85, 0.04, 0.15, 0.045, black);
        box(g, 0, 0.245, smg ? -0.62 : -0.85, 0.028, 0.022, 0.028, 0xc1d276);
    }
    box(g, 0.112, 0.07, 0.04, 0.02, 0.07, 0.17, metal);
    return finishGun(g, id);
}
export interface Character {
    classId: ClassId;
    color: number;
    group: THREE.Group;
    leftLeg: THREE.Group;
    rightLeg: THREE.Group;
    arms: THREE.Group;
    head: THREE.Group;
    gun: THREE.Group;
    weapon: WeaponId;
}
export function makeCharacter(classId: ClassId, color: number): Character {
    const g = new THREE.Group(), skin = 0xd6a476, pants = 0x30343b, vest = 0x343b3c;
    const leg = (x: number) => { const p = new THREE.Group(); p.position.set(x, 0.72, 0); box(p, 0, -0.28, 0, 0.27, 0.57, 0.30, pants); box(p, 0, -0.63, -0.06, 0.29, 0.17, 0.41, 0x25282a); g.add(p); return p; };
    const leftLeg = leg(-0.17), rightLeg = leg(0.17);
    box(g, 0, 1.03, 0, 0.70, 0.64, 0.4, color);
    box(g, 0, 1.03, -0.226, 0.51, 0.47, 0.07, vest);
    box(g, 0, 0.75, 0, 0.73, 0.075, 0.43, 0x292d2a);
    for (const x of [-0.155, 0.015, 0.18])
        box(g, x, 0.98, -0.285, 0.125, 0.23, 0.05, 0x5a6352);
    box(g, 0, 1.05, 0.27, 0.44, 0.45, 0.16, 0x464b3d);
    const head = new THREE.Group();
    head.position.y = 1.57;
    g.add(head);
    box(head, 0, 0, 0, 0.52, 0.50, 0.49, skin);
    box(head, 0, 0.23, 0.035, 0.57, 0.16, 0.54, classId === 'hunter' ? 0x536347 : color);
    box(head, 0, 0.17, -0.26, 0.58, 0.075, 0.2, 0x323b32);
    box(head, 0, 0.015, -0.254, 0.48, 0.115, 0.035, 0x20282a);
    box(head, 0, -0.13, -0.25, 0.50, 0.18, 0.04, 0x343b38);
    const arms = new THREE.Group();
    arms.position.set(0, 1.19, 0);
    g.add(arms);
    const left = box(arms, -0.42, -0.14, -0.14, 0.25, 0.52, 0.28, color);
    left.rotation.x = -0.8;
    left.rotation.z = -0.18;
    box(arms, -0.35, -0.28, -0.37, 0.23, 0.23, 0.35, skin);
    const right = box(arms, 0.43, -0.06, -0.17, 0.25, 0.49, 0.27, color);
    right.rotation.x = -1.03;
    box(arms, 0.33, -0.14, -0.39, 0.24, 0.22, 0.30, skin);
    const weapon = CLASSES[classId].weapon, gun = makeGun(weapon);
    gun.scale.setScalar(0.62);
    gun.position.set(0.18, -0.14, -0.46);
    arms.add(gun);
    for (const group of [g, leftLeg, rightLeg, arms, head])
        batchMeshes(group);
    return { classId, color, group: g, leftLeg, rightLeg, arms, head, gun, weapon };
}
export function animateCharacter(c: Character, speed: number, time: number, pitch: number, slide: number) { const walk = Math.sin(time * 13) * Math.min(0.75, speed * 0.08); c.leftLeg.rotation.x = walk; c.rightLeg.rotation.x = -walk; c.arms.rotation.x = pitch * 0.65; c.head.rotation.x = pitch * 0.5; c.group.scale.y = slide > 0 ? 0.68 : 1; }
export function releaseCharacter(c: Character) {
    for (const group of [c.group, c.head, c.arms, c.leftLeg, c.rightLeg])
        for (const child of group.children)
            if (child instanceof THREE.Mesh)
                child.geometry.dispose();
}
