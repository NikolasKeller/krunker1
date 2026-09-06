// Software geometry preview: no browser, WebGL, DOM layout or audio.
import * as THREE from 'three';
import { mkdir, writeFile } from 'node:fs/promises';
import { makeCharacter } from '../src/client/models';
import { Viewmodel } from '../src/client/viewmodel';
import { orientCamera } from '../src/client/camera';
import { headlessMap } from './map-geometry';
import { rasterize, png } from './software-renderer';

const width = 1024, height = 614;
const { scene } = headlessMap(true);
const character = makeCharacter('triggerman', 0xc66d58);
character.group.position.set(32, 0, -8); character.group.rotation.y = Math.PI; scene.add(character.group);
const camera = new THREE.PerspectiveCamera(90, width / height, .06, 220);
camera.position.set(34, 1.62, 16); orientCamera(camera, .22, .02);
const arena = rasterize(scene, camera);
await mkdir('artifacts', { recursive: true });
await writeFile('artifacts/arena-preview.png', png(arena));
const viewmodel = new Viewmodel(); viewmodel.resize(width, height); viewmodel.update(1, 0, 0, false, 0, 0, 0);
await writeFile('artifacts/geometry-preview.png', png(rasterize(viewmodel.scene, viewmodel.camera, { underlay: arena.rgba })));
console.log('Saved arena-preview.png and geometry-preview.png (software geometry only, not browser screenshots).');
