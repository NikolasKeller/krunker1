// Actual production geometry, rasterized entirely in software. No browser or CDP.
import * as THREE from 'three';
import { mkdir, writeFile } from 'node:fs/promises';
import { MAPS, type MapId } from '../src/shared/map';
import { headlessMap, auditMap } from './map-geometry';
import { rasterize, png } from './software-renderer';

const directory = 'artifacts/maps';
await mkdir(directory, { recursive: true });
const features: Record<MapId, [number, number, number, number, number, number]> = {
    sandyard: [28, 3, 31, 0, 4, 0],
    orbital: [-28, 4.62, 18, 54, 13, -10],
    abyss: [-24, 1.62, 10, -39, 3.4, -14],
    wildroot: [13, 1.62, 26, -4, 7, -3],
    catacomb: [-20, 1.62, -3, 0, 4, 2],
};
const manifest: { map: MapId; name: string; view: string; file: string; camera: number[]; boxes: number; ramps: number; boundsFailures: number }[] = [];
const columns = 3, tileWidth = 512, tileHeight = 307;
const sheet = { width: columns * tileWidth, height: MAPS.length * tileHeight, rgba: Buffer.alloc(columns * tileWidth * MAPS.length * tileHeight * 4) };
for (const [row, map] of MAPS.entries()) {
    const { scene, objects } = headlessMap(false, map);
    const failures = auditMap(scene, objects, map);
    if (failures.length) throw new Error(`${map.name}: ${failures.join('\n')}`);
    const views = [
        { name: 'overview', pose: [63, 70, 78, 0, 0, 0] },
        { name: 'spawn', pose: [-19.5, 1.62, 33, 0, 3, 0] },
        { name: 'landmark', pose: features[map.id] },
    ];
    for (const [column, view] of views.entries()) {
        const camera = new THREE.PerspectiveCamera(view.name === 'overview' ? 55 : 85, 1024 / 614, .06, 300);
        camera.position.set(view.pose[0], view.pose[1], view.pose[2]);
        camera.lookAt(view.pose[3], view.pose[4], view.pose[5]);
        const pixels = rasterize(scene, camera, map.palette);
        const file = `${map.id}-${view.name}.png`;
        await writeFile(`${directory}/${file}`, png(pixels));
        for (let y = 0; y < tileHeight; y++) for (let x = 0; x < tileWidth; x++) {
            const source = (y * 2 * pixels.width + x * 2) * 4;
            const target = ((row * tileHeight + y) * sheet.width + column * tileWidth + x) * 4;
            pixels.rgba.copy(sheet.rgba, target, source, source + 4);
        }
        manifest.push({ map: map.id, name: map.name, view: view.name, file, camera: view.pose, boxes: map.boxes.length, ramps: map.ramps.length, boundsFailures: failures.length });
        console.log(`${map.name} / ${view.name}: ${directory}/${file}`);
    }
}
await writeFile(`${directory}/contact-sheet.png`, png(sheet));
await writeFile(`${directory}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
await writeFile(`${directory}/index.html`, `<!doctype html><meta charset="utf-8"><title>Furo · Five maps</title>
<style>body{background:#171e24;color:#edf0df;font:16px system-ui;margin:32px}h1{font-size:36px}section{margin:40px 0}article{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}figure{margin:0}img{width:100%;border-radius:8px}figcaption{padding:8px 0;color:#b3c0b1}a{color:inherit}@media(max-width:800px){article{grid-template-columns:1fr}}</style>
<h1>Furo · Five maps</h1><p>Overview, spawn approach and landmark. Actual map geometry; software previews approximate lighting and omit WebGL shadows and canvas signs.</p>
${MAPS.map(map => `<section><h2>${map.name}</h2><p>${map.tagline}</p><article>${manifest.filter(m => m.map === map.id).map(m => `<figure><a href="${m.file}"><img src="${m.file}" alt="${map.name} ${m.view}"></a><figcaption>${m.view} · ${m.boxes} solids · ${m.ramps} ramps · bounds audit passed</figcaption></figure>`).join('')}</article></section>`).join('\n')}`);
