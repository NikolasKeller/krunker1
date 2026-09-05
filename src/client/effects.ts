import * as THREE from 'three';
import type { Vec3 } from '../shared/types';
import { material } from './models';
interface Effect {
    object: THREE.Object3D;
    life: number;
    max: number;
    velocity?: THREE.Vector3;
    dispose: boolean;
}
export class Effects {
    items: Effect[] = [];
    private particleGeo = new THREE.BoxGeometry(0.075, 0.075, 0.075);
    constructor(private scene: THREE.Scene) { }
    tracer(from: Vec3, to: Vec3, own = false) { const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(from.x, from.y, from.z), new THREE.Vector3(to.x, to.y, to.z)]); const mat = new THREE.LineBasicMaterial({ color: own ? 0xffe7a1 : 0xffce7a, transparent: true, opacity: 0.75 }); const line = new THREE.Line(geo, mat); this.scene.add(line); this.items.push({ object: line, life: 0.075, max: 0.075, dispose: true }); }
    particles(p: Vec3, blood = false, count = 7) { for (let i = 0; i < count; i++) {
        const m = new THREE.Mesh(this.particleGeo, material(blood ? 0xc75047 : 0xb29e78));
        m.position.set(p.x, p.y, p.z);
        m.scale.setScalar(blood ? 0.6 + Math.random() : 0.4 + Math.random());
        this.scene.add(m);
        this.items.push({ object: m, life: 0.35 + Math.random() * 0.2, max: 0.6, velocity: new THREE.Vector3((Math.random() - 0.5) * 4, Math.random() * 3, (Math.random() - 0.5) * 4), dispose: false });
    } }
    impact(p: Vec3, from: Vec3) { this.particles(p, false, 3); const m = new THREE.Mesh(this.particleGeo, material(0x665a49)); m.position.set(p.x, p.y, p.z); m.position.add(new THREE.Vector3(from.x - p.x, from.y - p.y, from.z - p.z).normalize().multiplyScalar(0.025)); m.scale.setScalar(1.4); this.scene.add(m); this.items.push({ object: m, life: 5, max: 5, dispose: false }); }
    update(dt: number) { for (let i = this.items.length - 1; i >= 0; i--) {
        const e = this.items[i];
        e.life -= dt;
        if (e.life <= 0 || this.items.length > 280) {
            this.scene.remove(e.object);
            if (e.dispose) {
                const o = e.object as THREE.Line;
                o.geometry.dispose();
                (o.material as THREE.Material).dispose();
            }
            this.items.splice(i, 1);
            continue;
        }
        if (e.velocity) {
            e.velocity.y -= 8 * dt;
            e.object.position.addScaledVector(e.velocity, dt);
            e.object.rotation.x += dt * 3;
        }
        if (e.object instanceof THREE.Line)
            (e.object.material as THREE.LineBasicMaterial).opacity = e.life / e.max * 0.7;
    } }
}
