import * as THREE from 'three';
import { batchMeshes, box, makeGun } from './models';
import { WEAPONS } from '../shared/weapons';
import type { WeaponId } from '../shared/types';
export class Viewmodel {
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(65, 1, 0.01, 10);
    rig = new THREE.Group();
    gun = new THREE.Group();
    rightArm = new THREE.Group();
    weapon: WeaponId = 'sniper';
    kick = 0;
    flashTime = 0;
    aim = 0;
    private flash: THREE.Mesh;
    constructor() {
        this.scene.add(new THREE.HemisphereLight(0xffffff, 0x858978, 2.1));
        const light = new THREE.DirectionalLight(0xfff1d7, 2.5);
        light.position.set(-3, 5, 3);
        this.scene.add(light);
        this.scene.add(this.rig);
        this.rig.scale.setScalar(.84);
        const arm = (group: THREE.Group, x: number, z: number) => { box(group, x, -0.2, z, 0.18, 0.18, 0.8, 0x565a58); box(group, x, -0.16, z - 0.48, 0.17, 0.17, 0.25, 0xd8aa82); batchMeshes(group); this.rig.add(group); };
        arm(this.rightArm, 0.16, 0.34);
        this.rightArm.rotation.z = 0.12;
        this.flash = new THREE.Mesh(new THREE.ConeGeometry(0.19, 0.45, 5), new THREE.MeshBasicMaterial({ color: 0xffe09b, transparent: true, opacity: 0.9, depthTest: false }));
        this.flash.rotation.x = -Math.PI / 2;
        this.rig.add(this.flash);
        this.setWeapon('sniper');
    }
    setWeapon(id: WeaponId) { this.rig.remove(this.gun); this.gun = makeGun(id); this.rig.add(this.gun); this.weapon = id; this.kick = 0.08; this.flash.position.set(0, 0.045, id === 'sniper' ? -1.38 : id === 'shotgun' ? -1.18 : id === 'pistol' ? -0.5 : -1.01); }
    muzzlePosition(camera: THREE.PerspectiveCamera) {
        this.rig.updateMatrixWorld(true); camera.updateMatrixWorld(true);
        const muzzle = this.flash.getWorldPosition(new THREE.Vector3());
        // Match the viewmodel's separate projection to the world camera so the
        // tracer begins at the visible muzzle during hip fire, ADS and reload.
        const ratio = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
        muzzle.x *= ratio; muzzle.y *= ratio;
        return muzzle.applyMatrix4(camera.matrixWorld);
    }
    fire() { this.kick = 1; this.flashTime = 0.075; this.flash.visible = this.weapon !== 'knife'; }
    update(dt: number, time: number, speed: number, aiming: boolean, reloadEnd: number, now: number, slide: number) {
        this.aim = THREE.MathUtils.clamp(this.aim + (aiming ? 1 : -1) * dt * 1000 / (WEAPONS[this.weapon].scopeTime || 100), 0, 1);
        this.kick = Math.max(0, this.kick - dt * 5);
        this.flashTime -= dt;
        this.flash.visible = this.flashTime > 0 && this.weapon !== 'knife';
        this.flash.rotation.y += dt * 24;
        const reload = reloadEnd > now ? 1 - (reloadEnd - now) / Math.max(1, WEAPONS[this.weapon].reload) : 0;
        const wave = reload > 0 ? Math.sin(reload * Math.PI) : 0, bob = Math.sin(time * 13) * Math.min(speed / 10, 1.7) * 0.018 * (1 - this.aim);
        this.rig.position.set(0.46 * (1 - this.aim), -0.40 - this.aim * 0.03 + bob - wave * 0.30, -1.10 + this.aim * 0.12 + this.kick * 0.1);
        this.rig.rotation.set(this.kick * 0.12 - wave * 0.42, Math.sin(time * 1.7) * 0.004 + wave * 0.13 + (this.weapon === 'sniper' ? .10 * (1 - this.aim) : 0), Math.cos(time * 6.5) * Math.min(speed / 10, 1) * 0.012 - wave * 0.45 - (slide > 0 ? 0.13 : 0));
        this.gun.rotation.x = this.weapon === 'knife' ? -this.kick * 0.8 : 0;
        if (this.weapon === 'sniper')
            this.rig.position.y -= this.aim * 0.23;
        else
            this.rig.position.y += this.aim * 0.19;
    }
    resize(w: number, h: number) { this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); }
}
