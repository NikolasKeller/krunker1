// Bundled into HUD fixtures for the calling agent's browser. The generator only
// writes HTML/JS; no browser or CDP is launched from this sandbox.
import * as THREE from 'three';
import type { WeaponId } from '../src/shared/types';
import { assertVisibleWeapon, createViewmodelFixture, type ViewmodelPose } from './viewmodel-fixture';
const weapon = document.body.dataset.weapon as WeaponId ?? 'sniper';
const pose = (document.body.dataset.pose ?? 'hip') as ViewmodelPose;
const canvas = document.querySelector<HTMLCanvasElement>('#game');
if (!canvas) throw new Error('Viewmodel preview requires a #game canvas');
const gl = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
gl.setPixelRatio(Math.min(devicePixelRatio, 1.6));
gl.outputColorSpace = THREE.SRGBColorSpace;
const vm = createViewmodelFixture(weapon, pose);
const draw = () => { gl.setSize(innerWidth, innerHeight); vm.resize(innerWidth, innerHeight); assertVisibleWeapon(vm); gl.render(vm.scene, vm.camera); };
addEventListener('resize', draw); draw();
Object.defineProperty(window, '__viewmodelPreview', { value: { weapon, pose, vm, draw } });
