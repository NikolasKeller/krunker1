import * as THREE from 'three';
import { makeCharacter, releaseCharacter, type Character } from './models';
import type { ClassId } from '../shared/types';

// Shared by the game and the standalone home preview: the actual playable model.
export class Showroom {
    readonly scene = new THREE.Scene();
    readonly camera = new THREE.PerspectiveCamera(31, 1, .1, 30);
    private character!: Character;
    constructor() {
        this.scene.add(new THREE.HemisphereLight(0xe3efff, 0x526354, 2.2));
        const key = new THREE.DirectionalLight(0xffe7c6, 2.7);
        key.position.set(-3, 5, -4);
        const rim = new THREE.DirectionalLight(0xc7f451, 2.2);
        rim.position.set(2, 3, 3);
        const fill = new THREE.DirectionalLight(0xa9d9ef, 1.1);
        fill.position.set(4, 2, -2);
        this.scene.add(key, rim, fill);
        const pad = new THREE.Mesh(new THREE.CylinderGeometry(1.08, 1.17, .14, 64), new THREE.MeshLambertMaterial({ color: 0x303e3d }));
        pad.position.y = -.09;
        const edge = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, .018, 64), new THREE.MeshBasicMaterial({ color: 0xc7f451 }));
        edge.position.y = -.045;
        this.scene.add(pad, edge);
        this.setClass('hunter');
    }
    setClass(id: ClassId) {
        if (this.character?.classId === id) return;
        if (this.character) { this.scene.remove(this.character.group); releaseCharacter(this.character); }
        const colors = { hunter: 0xb9bda2, triggerman: 0x768c68, vince: 0xaa6f54, runngun: 0x619398 };
        this.character = makeCharacter(id, colors[id]);
        this.scene.add(this.character.group);
        this.pose(0);
    }
    private pose(time: number) {
        const c = this.character, breath = Math.sin(time * 1.8);
        c.group.rotation.y = -.28 + Math.sin(time * .45) * .065;
        c.group.scale.y = 1 + breath * .006;
        c.arms.rotation.x = -.06 + breath * .016;
        c.head.rotation.y = Math.sin(time * .6) * .05;
        c.head.rotation.z = Math.sin(time * .8) * .012;
    }
    render(gl: THREE.WebGLRenderer, time: number, rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>, width: number, height: number) {
        gl.setViewport(0, 0, width, height);
        gl.setClearColor(0x161b20, 1);
        gl.clear();
        if (rect.width < 1 || rect.height < 1) return;
        this.pose(time);
        this.camera.aspect = rect.width / rect.height;
        // Fit both the full body and the pedestal on a narrow landscape-phone stage.
        const distance = Math.max(5.4, 5.4 / this.camera.aspect);
        this.camera.position.set(distance * .42, 1.1 + distance * .18, -distance * .91);
        this.camera.lookAt(0, .87, 0);
        this.camera.updateProjectionMatrix();
        gl.setViewport(rect.left, height - rect.top - rect.height, rect.width, rect.height);
        gl.setScissor(rect.left, height - rect.top - rect.height, rect.width, rect.height);
        gl.setScissorTest(true);
        gl.render(this.scene, this.camera);
        gl.setScissorTest(false);
        gl.setViewport(0, 0, width, height);
    }
}
