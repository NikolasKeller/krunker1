// Export the real UI DOM/CSS for the external browser verifier. This script never launches a browser.
import { build } from 'esbuild';
import { WEAPONS, CLASSES } from '../src/shared/weapons';
import type { WeaponId, ClassId } from '../src/shared/types';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { UI } from '../src/client/ui';
import type { Network } from '../src/client/network';
import type { Renderer } from '../src/client/renderer';
import { Room } from './sandyard-room';
import type { GameEvent } from '../src/shared/types';
import { installDOM } from './dom';
import { assertVisibleWeapon, createViewmodelFixture, VIEWMODEL_POSES, type ViewmodelPose } from './viewmodel-fixture';

const out = new URL('../artifacts/hud-preview/', import.meta.url);
await mkdir(out, { recursive: true });
let css = await readFile(new URL('../src/client/style.css', import.meta.url), 'utf8');
for (const match of css.matchAll(/url\('(?<path>\/fonts\/[^']+)'\)/g)) {
    const bytes = await readFile(new URL(`../public${match.groups!.path}`, import.meta.url));
    css = css.replace(match[0], `url('data:font/ttf;base64,${bytes.toString('base64')}')`);
}
const geometry = (await readFile(new URL('../artifacts/arena-preview.png', import.meta.url))).toString('base64');
const bundle = await build({ entryPoints: ['tests/viewmodel-preview.ts'], bundle: true, format: 'iife', write: false, minify: true });
const script = bundle.outputFiles[0].text.replaceAll('</script', '<\\/script');
const fixtures = [
    ...['lobby', 'ffa', 'tdm', 'body-hit', 'headshot', 'multikill'].map(state => ({ state, name: state, weapon: 'sniper' as WeaponId, pose: 'hip' as ViewmodelPose })),
    ...(Object.keys(WEAPONS) as WeaponId[]).flatMap(weapon => VIEWMODEL_POSES.map(pose => ({ state: 'ffa', name: `${weapon}-${pose}`, weapon, pose }))),
];
const scenes = [];
for (const { state, name, weapon, pose } of fixtures) {
    const { dom, restore } = installDOM('https://furo.example');
    try {
        Object.defineProperty(dom.window, 'innerWidth', { value: 1024 });
        Object.defineProperty(dom.window, 'innerHeight', { value: 614 });
        // installDOM provides only the UI root. Match index.html so the preview
        // renderer has an attached canvas before its bundled script runs.
        const canvas = document.createElement('canvas');
        canvas.id = 'game';
        document.body.prepend(canvas);
        if (state !== 'lobby') {
            const vm = createViewmodelFixture(weapon, pose);
            vm.resize(1024, 614);
            scenes.push({ name, weapon, pose, ...assertVisibleWeapon(vm) });
        }
        const room = new Room('PROOF');
        const classId = (Object.keys(CLASSES) as ClassId[]).find(id => CLASSES[id].weapon === weapon) ?? 'triggerman';
        const a = room.add('You', classId, 'blue').state;
        a.weapon = weapon; a.ammo = WEAPONS[weapon].magazine;
        const b = room.add('davidGE3', 'hunter', 'red').state;
        room.round.mode = state === 'ffa' ? 'ffa' : 'tdm';
        room.round.phase = state === 'lobby' ? 'lobby' : 'playing';
        room.round.endsAt = 139000;
        room.round.red = 13; room.round.blue = 17;
        const net = { id: a.id, host: a.id, room: room.id, ws: {}, status: 'CONNECTED', round: room.round,
            players: new Map([[a.id, a], [b.id, b]]), local: a, predicted: a, serverNow: 1000, ping: 15,
            difficulty: 'normal', bots: 0, remotePlayers: () => [], send() {} } as unknown as Network;
        const renderer = { fps: 144, viewmodel: { aim: 0 }, project: () => ({ x: 512, y: 280, visible: true }) } as unknown as Renderer;
        const ui = new UI(net);
        ui.menu = state === 'lobby';
        ui.visibility();
        const originalFetch = globalThis.fetch;
        try {
            globalThis.fetch = async () => Response.json({ publicUrl: location.origin, lan: [] });
            await ui.welcomed();
        } finally { globalThis.fetch = originalFetch; }
        ui.updateLobby();
        const kill: GameEvent = { type: 'kill', killer: a.id, victim: b.id, killerName: a.name, victimName: b.name, team: a.team, headshot: true, weapon: 'sniper' };
        if (state === 'body-hit') {
            ui.event({ type: 'hit', shooter: a.id, victim: b.id, damage: 35, zone: 'body', point: { x: 0, y: 1, z: 0 }, from: { x: 0, y: 1, z: 2 }, lethal: false }, renderer, 100);
        }
        if (state === 'headshot' || state === 'multikill') {
            a.ammo = 0;
            if (state === 'multikill') ui.event(kill, renderer, 0);
            ui.event({ type: 'hit', shooter: a.id, victim: b.id, damage: 175, zone: 'head', point: { x: 0, y: 1, z: 0 }, from: { x: 0, y: 1, z: 2 }, lethal: true }, renderer, 100);
            ui.event(kill, renderer, 100);
        }
        ui.update(100, renderer, false);
        // Serialize input properties too, so the static fixture retains the actual lobby form state.
        for (const field of document.querySelectorAll('input')) field.setAttribute('value', field.value);
        for (const field of document.querySelectorAll('select')) for (const option of field.options) option.toggleAttribute('selected', option.selected);
        const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Furo HUD review: ${name}</title><style>${css}
body { background:#cdbfbe url(data:image/png;base64,${geometry}) center/cover no-repeat; }
#damage-numbers>span { animation-play-state:paused; animation-delay:-.15s; }
</style><body data-weapon="${weapon}" data-pose="${pose}">${document.body.innerHTML}${state === 'lobby' ? '' : `<script>${script}</script>`}</body></html>`;
        await writeFile(new URL(`${name}.html`, out), html);
    } finally { restore(); }
}
await writeFile(new URL('viewmodel-scenes.json', out), JSON.stringify(scenes, null, 2) + '\n');
await writeFile(new URL('index.html', out), `<!doctype html><title>Viewmodel review</title><style>body{font:18px system-ui;background:#202829;color:white}a{color:#ffe5a2}li{margin:12px}</style><h1>HUD and viewmodel review</h1><p>Every weapon in hip, aiming and reload poses. Sniper aim freezes before full scope. Right arm retained.</p><ul>${fixtures.map(f => `<li><a href="${f.name}.html">${f.name}</a></li>`).join('')}</ul>`);
console.log('Exported 24 HUD/viewmodel fixtures and artifacts/hud-preview/index.html.');
console.log(`Verified visible weapon geometry in ${scenes.length} scenes; counts saved in viewmodel-scenes.json.`);
console.log('Real UI markup, CSS and embedded font; frozen feedback over a software geometry preview. No browser screenshots taken.');
