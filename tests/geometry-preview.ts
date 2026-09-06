// Software geometry preview, not a browser screenshot: no WebGL, DOM layout, shadows or audio.
import * as THREE from 'three';
import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { buildMap } from '../src/client/map-renderer';
import { makeCharacter } from '../src/client/models';
import { Viewmodel } from '../src/client/viewmodel';
import { orientCamera } from '../src/client/camera';
Object.defineProperty(globalThis, 'document', { value: { createElement: () => ({ width: 0, height: 0, getContext: () => ({ fillRect() {}, fillText() {} }) }) } });
const width = 1024, height = 614, rgba = Buffer.alloc(width * height * 4), depth = new Float64Array(width * height);
for (let i = 0; i < width * height; i++) { rgba[i * 4] = 205; rgba[i * 4 + 1] = 191; rgba[i * 4 + 2] = 190; rgba[i * 4 + 3] = 255; }
const sun = new THREE.Vector3(-30, 55, 20).normalize();
function render(scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    depth.fill(Infinity); scene.updateMatrixWorld(true); camera.updateMatrixWorld(true);
    const vp = camera.projectionMatrix.clone().multiply(camera.matrixWorldInverse);
    scene.traverse(o => {
        if (!(o instanceof THREE.Mesh) || !o.visible) return;
        // Canvas signs deliberately omitted: this is a geometry/framing diagnostic.
        const mat = o.material as THREE.MeshLambertMaterial;
        if (mat.map) return;
        const position = o.geometry.getAttribute('position'), color = o.geometry.getAttribute('color'), index = o.geometry.index;
        const indices = index?.count ?? position.count;
        for (let t = 0; t < indices; t += 3) {
            const ids = [0, 1, 2].map(i => index ? index.getX(t + i) : t + i);
            const world = ids.map(i => new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(o.matrixWorld));
            const normal = world[1].clone().sub(world[0]).cross(world[2].clone().sub(world[0])).normalize();
            if (normal.dot(camera.position.clone().sub(world[0])) <= 0) continue;
            const base = color ? new THREE.Color(color.getX(ids[0]), color.getY(ids[0]), color.getZ(ids[0])) : mat.color.clone();
            const brightness = .60 + Math.max(0, normal.dot(sun)) * .58;
            base.multiplyScalar(brightness).convertLinearToSRGB();
            const rgb = [base.r, base.g, base.b].map(c => Math.round(Math.min(1, c) * 255));
            const clip = world.map(p => new THREE.Vector4(p.x, p.y, p.z, 1).applyMatrix4(vp));
            const polygon: THREE.Vector4[] = [];
            for (let i = 0; i < 3; i++) {
                const a = clip[i], b = clip[(i + 1) % 3], da = a.z + a.w, db = b.z + b.w;
                if (da >= 0) polygon.push(a);
                if ((da >= 0) !== (db >= 0)) polygon.push(a.clone().lerp(b, da / (da - db)));
            }
            const screen = polygon.map(p => ({ x: (p.x / p.w + 1) * width / 2, y: (1 - p.y / p.w) * height / 2, z: p.z / p.w }));
            for (let k = 1; k + 1 < screen.length; k++) {
                const [a, b, c] = [screen[0], screen[k], screen[k + 1]];
                const area = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
                if (Math.abs(area) < .001) continue;
                const minX = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x))), maxX = Math.min(width - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
                const minY = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y))), maxY = Math.min(height - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
                for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
                    const u = ((b.y - c.y) * (x + .5 - c.x) + (c.x - b.x) * (y + .5 - c.y)) / area;
                    const v = ((c.y - a.y) * (x + .5 - c.x) + (a.x - c.x) * (y + .5 - c.y)) / area;
                    if (u < 0 || v < 0 || u + v > 1) continue;
                    const z = u * a.z + v * b.z + (1 - u - v) * c.z, pixel = y * width + x;
                    if (z > depth[pixel]) continue;
                    depth[pixel] = z; rgba[pixel * 4] = rgb[0]; rgba[pixel * 4 + 1] = rgb[1]; rgba[pixel * 4 + 2] = rgb[2];
                }
            }
        }
    });
}
const scene = new THREE.Scene(); buildMap(scene);
const character = makeCharacter('triggerman', 0xc66d58); character.group.position.set(32, 0, -8); character.group.rotation.y = Math.PI; scene.add(character.group);
const camera = new THREE.PerspectiveCamera(90, width / height, .06, 220);
camera.position.set(34, 1.62, 16); orientCamera(camera, .22, .02);
render(scene, camera);
function crc32(data: Buffer) { let crc = 0xffffffff; for (const b of data) { crc ^= b; for (let k = 0; k < 8; k++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type: string, data: Buffer) { const name = Buffer.from(type), size = Buffer.alloc(4), crc = Buffer.alloc(4); size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([name, data]))); return Buffer.concat([size, name, data, crc]); }
const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
async function save(path: string) {
const scan = Buffer.alloc((width * 4 + 1) * height);
for (let y = 0; y < height; y++) rgba.copy(scan, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
await mkdir('artifacts', { recursive: true });
await writeFile(path, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(scan)), chunk('IEND', Buffer.alloc(0))]));
}
await save('artifacts/arena-preview.png');
const viewmodel = new Viewmodel(); viewmodel.resize(width, height); viewmodel.update(1, 0, 0, false, 0, 0, 0);
render(viewmodel.scene, viewmodel.camera);
await save('artifacts/geometry-preview.png');
console.log('Saved arena-preview.png and geometry-preview.png (software geometry only, not browser screenshots).');
