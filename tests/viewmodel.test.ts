import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';
import { WEAPONS } from '../src/shared/weapons';
import type { WeaponId } from '../src/shared/types';
import type { Viewmodel } from '../src/client/viewmodel';
import { assertVisibleWeapon, createViewmodelFixture, VIEWMODEL_POSES } from './viewmodel-fixture';

const weapons = Object.keys(WEAPONS) as WeaponId[];
for (const weapon of weapons) for (const pose of VIEWMODEL_POSES) test(`${weapon}/${pose}: visible weapon geometry and right arm remain in the viewmodel scene`, () => {
    const vm = createViewmodelFixture(weapon, pose);
    vm.resize(1024, 614);
    assertVisibleWeapon(vm);
    assert.equal('leftArm' in vm, false);
    assert.equal(vm.rightArm.parent, vm.rig);
    assert.equal(vm.rig.children.filter(child => child instanceof THREE.Group && child !== vm.gun).length, 1);
    assert.ok(vm.rightArm.children.some(child => child instanceof THREE.Mesh && child.visible && child.geometry.getAttribute('position').count > 0));
    // Exercise firing, recoil, moving sway, sliding and switching weapons too.
    vm.fire();
    vm.update(1 / 60, 1, 10, pose === 'aim', pose === 'reload' ? 1000 + WEAPONS[weapon].reload * .5 : 0, 1000, .2);
    assertVisibleWeapon(vm);
    vm.setWeapon(weapon === 'knife' ? 'pistol' : 'knife');
    vm.setWeapon(weapon);
    assertVisibleWeapon(vm);
});

test('visibility regression check rejects a missing, hidden or offscreen weapon even with a right arm present', () => {
    const mutations: ((vm: Viewmodel) => void)[] = [
        vm => vm.rig.remove(vm.gun),
        vm => vm.gun.clear(),
        vm => { vm.rig.visible = false; },
        vm => { vm.gun.visible = false; },
        vm => vm.gun.traverse(child => { if ((child as THREE.Mesh).isMesh) child.visible = false; }),
        vm => { vm.gun.position.x = 100; },
    ];
    for (const mutate of mutations) {
        const vm = createViewmodelFixture('pistol', 'hip');
        vm.resize(1024, 614);
        mutate(vm);
        assert.throws(() => assertVisibleWeapon(vm), /weapon detached|no visible weapon mesh/);
    }
});

test('every generated HUD preview supplies a canvas and boots a visible weapon scene', async () => {
    const root = fileURLToPath(new URL('../', import.meta.url));
    await promisify(execFile)(process.execPath, ['--import', 'tsx', 'tests/hud-preview.ts'], { cwd: root });
    // Execute the real preview entry and Three.js geometry in a Node DOM. Only
    // the GPU renderer is replaced; no browser, WebGL context or CDP is started.
    const bundle = await build({
        absWorkingDir: root, entryPoints: ['tests/viewmodel-preview.ts'], bundle: true, format: 'iife', write: false,
        plugins: [{ name: 'preview-renderer-spy', setup(build) {
            build.onResolve({ filter: /^three$/ }, args => args.importer.endsWith('/tests/viewmodel-preview.ts') ? { path: 'renderer-spy', namespace: 'preview-test' } : undefined);
            build.onLoad({ filter: /.*/, namespace: 'preview-test' }, () => ({ resolveDir: root, contents: `
                export * from 'three';
                export class WebGLRenderer {
                    constructor({ canvas }) {
                        if (!(canvas instanceof HTMLCanvasElement) || !canvas.isConnected) throw new Error('Missing preview canvas');
                        this.domElement = canvas;
                    }
                    setPixelRatio() {}
                    setSize(width, height) { this.domElement.width = width; this.domElement.height = height; }
                    render(scene, camera) { window.__previewRender = { scene, camera, canvas: this.domElement }; }
                }
            ` }));
        } }],
    });
    const names = [...weapons.flatMap(weapon => VIEWMODEL_POSES.map(pose => `${weapon}-${pose}`)), 'ffa', 'tdm', 'body-hit', 'headshot', 'multikill'];
    for (const name of names) {
        const html = await readFile(new URL(`../artifacts/hud-preview/${name}.html`, import.meta.url), 'utf8');
        const dom = new JSDOM(html, { runScripts: 'outside-only' });
        try {
            const { window } = dom;
            assert.equal(window.document.querySelectorAll('canvas#game').length, 1, `${name}: missing viewmodel canvas`);
            const scripts = window.document.querySelectorAll('script');
            assert.equal(scripts.length, 1, `${name}: missing preview script`);
            new Script(scripts[0].textContent!, { filename: `${name}.html` });
            window.eval(bundle.outputFiles[0].text);
            const preview = window.__viewmodelPreview as { weapon: WeaponId; pose: string; vm: Viewmodel; draw: () => void };
            assert.equal(preview.weapon, window.document.body.dataset.weapon);
            assert.equal(preview.pose, window.document.body.dataset.pose);
            assert.equal(window.__previewRender.scene, preview.vm.scene);
            assert.equal(window.__previewRender.camera, preview.vm.camera);
            assert.equal(window.__previewRender.canvas, window.document.querySelector('#game'));
            assertVisibleWeapon(preview.vm);
            window.dispatchEvent(new window.Event('resize'));
            assertVisibleWeapon(preview.vm);
        } finally { dom.window.close(); }
    }
});
