import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { Showroom } from '../src/client/showroom';
import { CLASS_IDS } from '../src/shared/weapons';

// Verify the production camera/model without creating a browser or GPU context.
const gl = { setViewport() {}, setClearColor() {}, clear() {}, setScissor() {}, setScissorTest() {}, render() {} } as unknown as THREE.WebGLRenderer;
test('all home classes and their platform fit the camera on desktop and narrow phone stages throughout idle', () => {
    const showroom = new Showroom();
    for (const classId of CLASS_IDS) {
        showroom.setClass(classId);
        for (const [width, height] of [[620, 470], [210, 235], [180, 330]]) for (const time of [0, 2, 7]) {
            showroom.render(gl, time, { left: 30, top: 100, width, height }, 1280, 800);
            showroom.scene.updateMatrixWorld(true); showroom.camera.updateMatrixWorld(true);
            for (const object of showroom.scene.children) {
                if (!(object instanceof THREE.Mesh || object instanceof THREE.Group)) continue;
                object.traverse(child => {
                    if (!(child instanceof THREE.Mesh)) return;
                    const positions = child.geometry.getAttribute('position');
                    for (let i = 0; i < positions.count; i++) {
                        const p = new THREE.Vector3().fromBufferAttribute(positions, i).applyMatrix4(child.matrixWorld).project(showroom.camera);
                        assert.ok(Math.abs(p.x) < .99 && Math.abs(p.y) < .99 && p.z < 1, `${classId} clips at ${width}×${height}, t=${time}: ${p.toArray()}`);
                    }
                });
            }
        }
    }
});
test('the displayed character idles while its feet stay planted, and changing class replaces its weapon', () => {
    const showroom = new Showroom();
    const character = () => showroom.scene.children.find(c => c instanceof THREE.Group)!;
    showroom.render(gl, 0, { left: 0, top: 0, width: 600, height: 500 }, 1280, 800);
    const first = character(), initial = first.rotation.y;
    showroom.render(gl, 3, { left: 0, top: 0, width: 600, height: 500 }, 1280, 800);
    assert.notEqual(first.rotation.y, initial); assert.equal(first.position.y, 0);
    showroom.setClass('vince'); assert.notEqual(character(), first); assert.equal(first.parent, null);
    const vince = character(); showroom.setClass('vince'); assert.equal(character(), vince, 'unchanged selections keep their model');
});
