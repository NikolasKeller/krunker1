import * as THREE from 'three';
import { deflateSync } from 'node:zlib';
// Repository geometry rasterizer: deliberately independent of DOM, WebGL and browsers.
const sun = new THREE.Vector3(-30, 55, 20).normalize();
export function rasterize(scene: THREE.Scene, camera: THREE.PerspectiveCamera, options: { width?: number; height?: number; sky?: number; ambient?: number; sun?: number; underlay?: Buffer } = {}) {
    const width = options.width ?? 1024, height = options.height ?? 614;
    const rgba = options.underlay ? Buffer.from(options.underlay) : Buffer.alloc(width * height * 4), depth = new Float64Array(width * height);
    const sky = new THREE.Color(options.sky ?? 0xcdbfbe).convertLinearToSRGB();
    if (!options.underlay) for (let i = 0; i < width * height; i++) { rgba[i * 4] = sky.r * 255; rgba[i * 4 + 1] = sky.g * 255; rgba[i * 4 + 2] = sky.b * 255; rgba[i * 4 + 3] = 255; }
    const ambient = new THREE.Color(options.ambient ?? 0xffffff), sunlight = new THREE.Color(options.sun ?? 0xffffff);
    depth.fill(Infinity); scene.updateMatrixWorld(true); camera.updateMatrixWorld(true);
    const vp = camera.projectionMatrix.clone().multiply(camera.matrixWorldInverse);
    const meshes: THREE.Mesh[] = [], lamps: THREE.PointLight[] = [];
    scene.traverse(o => { if (o instanceof THREE.PointLight) lamps.push(o); });
    scene.traverse(o => { if (o instanceof THREE.Mesh && o.visible) meshes.push(o); });
    meshes.sort((a, b) => Number((a.material as THREE.Material).transparent) - Number((b.material as THREE.Material).transparent) ||
        b.getWorldPosition(new THREE.Vector3()).distanceToSquared(camera.position) - a.getWorldPosition(new THREE.Vector3()).distanceToSquared(camera.position));
    for (const o of meshes) {
        // Canvas signs deliberately omitted: this is a geometry/framing diagnostic.
        const mat = o.material as THREE.MeshLambertMaterial;
        if (mat.map) continue;
        const position = o.geometry.getAttribute('position'), color = o.geometry.getAttribute('color'), index = o.geometry.index;
        const indices = index?.count ?? position.count;
        for (let t = 0; t < indices; t += 3) {
            const ids = [0, 1, 2].map(i => index ? index.getX(t + i) : t + i);
            const world = ids.map(i => new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(o.matrixWorld));
            const normal = world[1].clone().sub(world[0]).cross(world[2].clone().sub(world[0])).normalize();
            if (normal.dot(camera.position.clone().sub(world[0])) <= 0) continue;
            const base = color ? new THREE.Color(color.getX(ids[0]), color.getY(ids[0]), color.getZ(ids[0])) : mat.color.clone();
            if (!(mat instanceof THREE.MeshBasicMaterial)) {
                const lighting = ambient.clone().multiplyScalar(.62).add(sunlight.clone().multiplyScalar(Math.max(0, normal.dot(sun)) * .65));
                const center = world[0].clone().add(world[1]).add(world[2]).multiplyScalar(1 / 3);
                for (const lamp of lamps) {
                    const direction = lamp.getWorldPosition(new THREE.Vector3()).sub(center), distance = direction.length();
                    if (distance < lamp.distance) lighting.add(lamp.color.clone().multiplyScalar(Math.max(0, normal.dot(direction.normalize())) * lamp.intensity / Math.max(1, distance ** lamp.decay) * (1 - distance / lamp.distance)));
                }
                base.multiply(lighting);
            }
            base.convertLinearToSRGB();
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
                    const z = u * a.z + v * b.z + (1 - u - v) * c.z + (mat.polygonOffset ? mat.polygonOffsetFactor * .000001 : 0), pixel = y * width + x;
                    if (z > depth[pixel]) continue;
                    if (mat.depthWrite) depth[pixel] = z;
                    const alpha = mat.transparent ? mat.opacity : 1;
                    for (let channel = 0; channel < 3; channel++) rgba[pixel * 4 + channel] = rgb[channel] * alpha + rgba[pixel * 4 + channel] * (1 - alpha);
                }
            }
        }
    }
    return { width, height, rgba };
}
function crc32(data: Buffer) { let crc = 0xffffffff; for (const b of data) { crc ^= b; for (let k = 0; k < 8; k++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type: string, data: Buffer) { const name = Buffer.from(type), size = Buffer.alloc(4), crc = Buffer.alloc(4); size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([name, data]))); return Buffer.concat([size, name, data, crc]); }
export function png({ width, height, rgba }: { width: number; height: number; rgba: Buffer }) {
    const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
    const scan = Buffer.alloc((width * 4 + 1) * height);
    for (let y = 0; y < height; y++) rgba.copy(scan, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(scan)), chunk('IEND', Buffer.alloc(0))]);
}
