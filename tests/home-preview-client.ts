// Browser entry for the generated, server-free visual review page.
import * as THREE from 'three';
import { UI } from '../src/client/ui';
import { Showroom } from '../src/client/showroom';
import type { Network } from '../src/client/network';
import { CLASS_IDS } from '../src/shared/weapons';

localStorage.setItem('arena-name', 'Niko');
const net = { id: '', room: '', host: '', status: 'CREATE OR JOIN A LOBBY', players: new Map(), difficulty: 'normal', bots: 5,
    serverNow: 0, send() {}, disconnect() {} } as unknown as Network;
const ui = new UI(net), showroom = new Showroom();
ui.choose(CLASS_IDS.find(id => location.hash.includes(id)) ?? 'hunter', false);
showroom.setClass(ui.selected);
ui.updateLobby();
ui.onClass = id => showroom.setClass(id);
const canvas = document.getElementById('game') as HTMLCanvasElement;
const gl = new THREE.WebGLRenderer({ canvas, antialias: true });
gl.setPixelRatio(Math.min(devicePixelRatio, 1.5));
gl.outputColorSpace = THREE.SRGBColorSpace;
gl.autoClear = false;
const resize = () => gl.setSize(innerWidth, innerHeight);
window.addEventListener('resize', resize); resize();
const stage = document.getElementById('home-character')!;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const preview = { ui, showroom, ready: false };
Object.assign(window, { __homePreview: preview });
function frame(time: number) {
    if (ui.home) showroom.render(gl, reducedMotion.matches ? 0 : time / 1000, stage.getBoundingClientRect(), innerWidth, innerHeight);
    preview.ready = true;
    requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
document.getElementById('character-loading')!.classList.add('hidden');
if (location.hash.includes('join')) document.getElementById('home-join')!.click();
// Review automation can await window.__homePreview.ready and document.fonts.ready.
