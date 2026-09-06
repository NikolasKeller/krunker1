// Bundled into HUD fixtures for the calling agent's browser. The generator only
// writes HTML/JS; no browser or CDP is launched from this sandbox.
import * as THREE from 'three';
import { Viewmodel } from '../src/client/viewmodel';
import { WEAPONS } from '../src/shared/weapons';
import type { WeaponId } from '../src/shared/types';
const weapon = document.body.dataset.weapon as WeaponId ?? 'sniper';
const pose = document.body.dataset.pose ?? 'hip';
const canvas = document.querySelector<HTMLCanvasElement>('#game')!;
const gl = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
gl.setPixelRatio(Math.min(devicePixelRatio, 1.6));
gl.outputColorSpace = THREE.SRGBColorSpace;
const vm = new Viewmodel(); vm.setWeapon(weapon);
vm.update(1, 0, 0, false, 0, 1000, 0);
// The sniper aim fixture freezes mid-transition, before the scope replaces it.
if (pose === 'aim') vm.update(WEAPONS[weapon].scopeTime / 1000 * (weapon === 'sniper' ? .65 : 1), 0, 0, true, 0, 1000, 0);
if (pose === 'reload') vm.update(0, 0, 0, false, 1000 + WEAPONS[weapon].reload * .5, 1000, 0);
const draw = () => { gl.setSize(innerWidth, innerHeight); vm.resize(innerWidth, innerHeight); gl.render(vm.scene, vm.camera); };
addEventListener('resize', draw); draw();
Object.defineProperty(window, '__viewmodelPreview', { value: { weapon, pose, vm, draw } });
