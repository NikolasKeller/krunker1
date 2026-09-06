import { getClientMap, type MapId } from '../shared/map';
import * as THREE from 'three';
import { correctedPosition } from './prediction';
import { orientCamera } from './camera';
import { buildMap } from './map-renderer';
import { animateCharacter, makeCharacter, makeGun, releaseCharacter, type Character } from './models';
import { Effects } from './effects';
import { Showroom } from './showroom';
import { Viewmodel } from './viewmodel';
import { eyeHeight } from '../shared/movement';
import { CLASSES } from '../shared/weapons';
import type { ClassId, PlayerState, Vec3 } from '../shared/types';
export class Renderer {
    gl: THREE.WebGLRenderer;
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(90, 1, 0.06, 220);
    effects: Effects;
    viewmodel = new Viewmodel();
    characters = new Map<string, Character>();
    fps = 0;
    drawCalls = 0;
    triangles = 0;
    private sun: THREE.DirectionalLight;
    private ambient: THREE.HemisphereLight;
    private mapScene = new THREE.Scene();
    private mapId?: MapId;
    private quality = 'balanced';
    private resolutionScale = 1;
    private width = 1;
    private height = 1;
    private fpsTime = 0;
    private frames = 0;
    private damageKick = 0;
    private eye = 1.62;
    private menuTime = 0;
    private showroom = new Showroom();
    constructor(canvas: HTMLCanvasElement, private touch = false) {
        try {
            this.gl = new THREE.WebGLRenderer({ canvas, antialias: !touch, powerPreference: 'high-performance' });
        } catch (cause) {
            throw new Error('WebGL could not start. Enable hardware acceleration in your browser and reload.', { cause });
        }
        this.gl.setPixelRatio(Math.min(devicePixelRatio, 1.35));
        this.gl.outputColorSpace = THREE.SRGBColorSpace;
        this.gl.toneMapping = THREE.NoToneMapping;
        this.gl.shadowMap.enabled = true;
        this.gl.shadowMap.type = THREE.PCFSoftShadowMap;
        this.gl.autoClear = false;
        this.gl.info.autoReset = false;
        this.scene.background = new THREE.Color(0xcdbfbe);
        this.scene.fog = new THREE.Fog(0xcdbfbe, 75, 160);
        this.ambient = new THREE.HemisphereLight(0xf4f9ff, 0xaaa5a0, 1.7);
        this.scene.add(this.ambient);
        const sun = this.sun = new THREE.DirectionalLight(0xfff0d4, 2.2);
        sun.position.set(-30, 55, 20);
        sun.castShadow = true;
        sun.shadow.mapSize.set(1536, 1536);
        Object.assign(sun.shadow.camera, { left: -47, right: 47, top: 47, bottom: -47, near: 1, far: 125 });
        sun.shadow.bias = -0.0005;
        sun.shadow.normalBias = 0.025;
        this.scene.add(sun);
        this.scene.add(this.mapScene);
        this.updateMap();
        this.effects = new Effects(this.scene);
        this.camera.rotation.order = 'YXZ';
        addEventListener('resize', () => this.resize());
        this.resize();
    }
    private updateMap() {
        const map = getClientMap();
        if (this.mapId === map.id) return;
        // Only merged map buffers and map-specific materials are owned here.
        // Shared box geometry/materials are retained by the model cache.
        this.mapScene.traverse(o => {
            if (!(o instanceof THREE.Mesh)) return;
            const mat = o.material as THREE.MeshLambertMaterial;
            if (o.geometry.hasAttribute('color')) o.geometry.dispose();
            if (mat instanceof THREE.MeshBasicMaterial) { mat.map?.dispose(); mat.dispose(); }
            else if (mat.userData.mapOwned) mat.dispose();
        });
        this.mapScene.clear(); this.mapId = map.id;
        buildMap(this.mapScene, { map });
        this.scene.background = new THREE.Color(map.palette.sky);
        this.scene.fog = new THREE.Fog(map.palette.sky, this.touch ? 70 : 75, this.touch ? 120 : 160);
        this.ambient.color.setHex(map.palette.ambient);
        this.ambient.groundColor.setHex(map.palette.floor);
        this.sun.color.setHex(map.palette.sun); this.sun.intensity = map.palette.intensity;
    }
    setTouch(touch: boolean) { this.touch = touch; this.applyQuality(); }
    setResolutionScale(scale: number) { this.resolutionScale = scale; this.applyQuality(); }
    setQuality(quality: string) {
        this.quality = quality; this.resolutionScale = 1; this.applyQuality();
        localStorage.setItem('arena-quality', quality);
    }
    private applyQuality() {
        const high = this.quality === 'high', low = this.quality === 'low';
        const cap = this.touch ? (high ? 1.15 : 1) : low ? 1 : high ? 1.6 : 1.35;
        this.gl.setPixelRatio(Math.min(devicePixelRatio, cap) * this.resolutionScale);
        this.gl.shadowMap.enabled = !low;
        const size = this.touch ? (high ? 1024 : 512) : 1536;
        if (this.sun.shadow.mapSize.x !== size) {
            this.sun.shadow.mapSize.set(size, size);
            this.sun.shadow.map?.dispose(); this.sun.shadow.map = null;
        }
        // The complete arena remains in range; only distant background is culled.
        this.camera.far = this.touch ? 120 : 220;
        this.scene.fog = new THREE.Fog(getClientMap().palette.sky, this.touch ? 70 : 75, this.touch ? 120 : 160);
        this.resize();
    }
    private resize() { this.width = innerWidth; this.height = innerHeight; this.gl.setSize(this.width, this.height); this.camera.aspect = this.width / this.height; this.camera.updateProjectionMatrix(); this.viewmodel.resize(this.width, this.height); }
    setClass(id: ClassId) { this.showroom.setClass(id); }
    renderHome(time: number, rect: DOMRect) {
        this.gl.info.reset();
        this.showroom.render(this.gl, time, rect, this.width, this.height);
        this.drawCalls = this.gl.info.render.calls;
        this.triangles = this.gl.info.render.triangles;
    }
    shotMuzzle(local: PlayerState, look: { yaw: number; pitch: number }, correction: Vec3) {
        const camera = this.camera.clone(), view = correctedPosition(local, correction);
        camera.position.set(view.x, view.y + this.eye, view.z);
        orientCamera(camera, look.yaw, look.pitch);
        return this.viewmodel.muzzlePosition(camera);
    }
    damage() { this.damageKick = 0.2; }
    project(p: Vec3) { const v = new THREE.Vector3(p.x, p.y, p.z).project(this.camera); return { x: (v.x * 0.5 + 0.5) * this.width, y: (-v.y * 0.5 + 0.5) * this.height, visible: v.z < 1 && v.z > 0 }; }
    render(dt: number, time: number, local: PlayerState | undefined, remotes: PlayerState[], look: {
        yaw: number;
        pitch: number;
    }, correction: Vec3, menu: boolean, aiming: boolean, serverNow: number, mode: string) {
        this.updateMap();
        this.frames++;
        if (!this.fpsTime)
            this.fpsTime = time;
        const frameWindow = time - this.fpsTime;
        if (frameWindow >= 0.75) {
            this.fps = Math.round(this.frames / frameWindow);
            this.frames = 0;
            this.fpsTime = time;
        }
        this.effects.update(dt);
        this.damageKick = Math.max(0, this.damageKick - dt);
        const ids = new Set(remotes.map(p => p.id));
        for (const [id, c] of this.characters)
            if (!ids.has(id)) {
                this.scene.remove(c.group);
                releaseCharacter(c);
                this.characters.delete(id);
            }
        for (const p of remotes) {
            let c = this.characters.get(p.id);
            const friendly = mode === 'tdm' && p.team === local?.team;
            const color = mode === 'tdm' ? (p.team === 'blue' ? 0x599fb6 : 0xc66d58) : 0xb47b59;
            if (c && (c.classId !== p.classId || c.color !== color)) {
                this.scene.remove(c.group);
                releaseCharacter(c);
                this.characters.delete(p.id);
                c = undefined;
            }
            if (!c) {
                c = makeCharacter(p.classId, color);
                this.characters.set(p.id, c);
                this.scene.add(c.group);
            }
            c.group.visible = p.alive;
            c.group.position.set(p.x, p.y, p.z);
            c.group.rotation.y = p.yaw;
            if (c.weapon !== p.weapon) {
                c.arms.remove(c.gun);
                c.gun = makeGun(p.weapon);
                c.gun.scale.setScalar(0.62);
                c.gun.position.set(0.18, -0.14, -0.46);
                c.arms.add(c.gun);
                c.weapon = p.weapon;
            }
            animateCharacter(c, Math.hypot(p.vx, p.vz), time, p.pitch, p.slide);
            void friendly;
        }
        if (menu) {
            this.menuTime += dt;
            const phase = this.menuTime * 0.025;
            this.camera.position.set(-28 + Math.sin(phase) * 3, 9.5, 29);
            this.camera.lookAt(1, 2, -7);
            this.camera.fov = 67;
        }
        else if (local) {
            const speed = Math.hypot(local.vx, local.vz);
            const crouch = eyeHeight(local);
            this.eye = THREE.MathUtils.damp(this.eye, crouch, 18, dt);
            const bob = local.grounded ? Math.sin(time * 14) * Math.min(speed / 10, 1.5) * 0.022 : 0;
            const view = correctedPosition(local, correction);
            this.camera.position.set(view.x, view.y + this.eye + bob, view.z);
            orientCamera(this.camera, look.yaw, look.pitch + Math.sin(time * 72) * this.damageKick * 0.07, Math.cos(time * 61) * this.damageKick * 0.08 + (local.slide > 0 ? -0.035 : 0));
            const scoped = aiming && local.weapon === 'sniper';
            this.camera.fov = THREE.MathUtils.damp(this.camera.fov, scoped ? 32 : aiming ? 73 : 90 + Math.min(8, Math.max(0, speed - 10) * 0.65), scoped ? 18 : 12, dt);
            if (this.viewmodel.weapon !== local.weapon)
                this.viewmodel.setWeapon(local.weapon);
            this.viewmodel.update(dt, time, speed, aiming, local.reloadEnd, serverNow, local.slide);
        }
        this.camera.updateProjectionMatrix();
        this.gl.setViewport(0, 0, this.width, this.height);
        this.gl.info.reset();
        this.gl.clear();
        this.gl.render(this.scene, this.camera);
        if (!menu && local?.alive && !(aiming && local.weapon === 'sniper' && this.viewmodel.aim > 0.82)) {
            this.gl.clearDepth();
            this.gl.render(this.viewmodel.scene, this.viewmodel.camera);
        }
        this.drawCalls = this.gl.info.render.calls;
        this.triangles = this.gl.info.render.triangles;
    }
}
