// Produces a portable folder of phone layout fixtures. Never launches a browser.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { UI } from '../src/client/ui';
import { Controls } from '../src/client/input';
import type { Network } from '../src/client/network';
import type { Renderer } from '../src/client/renderer';
import { Room } from '../src/server/simulation';
import { CLASS_IDS } from '../src/shared/weapons';
import { installDOM } from './dom';
const out = new URL('../artifacts/mobile-preview/', import.meta.url);
await mkdir(out, { recursive: true });
let css = await readFile(new URL('../src/client/style.css', import.meta.url), 'utf8');
for (const match of css.matchAll(/url\('(?<path>\/fonts\/[^']+)'\)/g)) {
    const bytes = await readFile(new URL(`../public${match.groups!.path}`, import.meta.url));
    css = css.replace(match[0], `url('data:font/ttf;base64,${bytes.toString('base64')}')`);
}
const background = (await readFile(new URL('../artifacts/arena-preview.png', import.meta.url))).toString('base64');
const bundle = await build({ entryPoints: ['tests/viewmodel-preview.ts'], bundle: true, format: 'iife', write: false, minify: true });
await writeFile(new URL('viewmodel.js', out), bundle.outputFiles[0].text);
const states = ['match', 'moving', 'reloading', 'lobby', 'full-lobby', 'invite', 'scoreboard', 'settings', 'portrait'];
for (const state of states) {
    const env = installDOM('https://furo.example/?room=FRND5');
    try {
        Object.defineProperty(window.navigator, 'maxTouchPoints', { value: 5 });
        Object.defineProperty(window, 'innerWidth', { value: 844 }); Object.defineProperty(window, 'innerHeight', { value: 390 });
        const canvas = document.createElement('canvas'); canvas.id = 'game'; document.body.prepend(canvas);
        const room = new Room('FRND5'); room.botCount = 0;
        const names = ['Niko', 'Ada', 'Mio', 'Jules', 'Robin', 'Sam', 'LongCallsign1234', 'Luca', 'Sasha', 'Noa'];
        const players = names.slice(0, state === 'full-lobby' ? 10 : 4).map((name, i) => {
            const p = room.add(name, CLASS_IDS[i % 4], i % 2 ? 'red' : 'blue').state;
            p.ready = i !== 1; p.kills = 5 - i; p.score = (5 - i) * 100; return p;
        });
        const p = players[0]; p.classId = 'triggerman'; p.weapon = 'rifle'; p.ammo = state === 'reloading' ? 0 : 18;
        p.reloadEnd = state === 'reloading' ? 2100 : 0; p.protectionEnd = 0; p.hp = 74; p.maxHp = 100;
        room.round.mode = 'tdm'; room.round.phase = state.includes('lobby') ? 'lobby' : 'playing';
        room.round.endsAt = 139000; room.round.blue = 12; room.round.red = 9;
        const net = { id: p.id, room: room.id, host: p.id, ws: {}, status: 'CONNECTED', round: room.round, players: new Map(players.map(p => [p.id, p])), local: p, predicted: p, serverNow: 1000, ping: 35, difficulty: 'normal', bots: 0, send() {}, remotePlayers: () => [] } as unknown as Network;
        const ui = new UI(net); ui.choose('triggerman', false);
        const fetchBefore = globalThis.fetch;
        try { globalThis.fetch = async () => Response.json({ lan: [], publicUrl: location.origin }); await ui.welcomed(); }
        finally { globalThis.fetch = fetchBefore; }
        ui.menu = state.includes('lobby'); ui.paused = state === 'invite'; ui.visibility(); ui.updateLobby();
        ui.scoreOpen = state === 'scoreboard';
        const renderer = { fps: 60, viewmodel: { aim: 0 }, project: () => ({ x: 422, y: 195, visible: true }) } as unknown as Renderer;
        ui.event({ type: 'kill', killer: players[1].id, victim: players[2].id, killerName: players[1].name, victimName: players[2].name, weapon: 'sniper', headshot: false, team: 'red' }, renderer, 100);
        ui.update(100, renderer, false, []);
        const controls = new Controls(canvas);
        if (state === 'moving') { controls.touch.begin(1, 'move', 105, 285); controls.touch.move(1, 125, 250); controls.drawTouch(); }
        if (state === 'settings') document.getElementById('settings')!.classList.remove('hidden');
        for (const field of document.querySelectorAll('input')) field.setAttribute('value', field.value);
        for (const field of document.querySelectorAll('select')) for (const option of field.options) option.toggleAttribute('selected', option.selected);
        await writeFile(new URL(`${state}.html`, out), `<!doctype html><html lang="en" class="touch-device ${ui.menu || ui.paused ? '' : 'touch-playing'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>Furo phone · ${state}</title><style>${css}\nbody{background:#cdbfbe url(data:image/png;base64,${background}) center/cover no-repeat}</style></head><body data-weapon="rifle" data-pose="${state === 'reloading' ? 'reload' : 'hip'}">${document.body.innerHTML}${ui.menu ? '' : `<script src="./viewmodel.js"></script>`}</body></html>`);
    } finally { env.restore(); }
}
await writeFile(new URL('index.html', out), `<!doctype html><html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Furo phone previews</title><style>body{font:18px system-ui;background:#182329;color:#eee;padding:20px}a{color:#c7f451;display:inline-block;padding:12px}</style><h1>Furo phone layouts</h1><p>Review at 844 × 390 and 667 × 375 in landscape. Portrait: 390 × 844. These are frozen layout fixtures using production UI/CSS, with a rendered weapon; match controls are exercised in the live app and tests.</p>${states.map(s => `<p><a href="${s}.html">${s}</a></p>`).join('')}</html>`);
console.log(`Generated ${states.length} phone previews at artifacts/mobile-preview/index.html`);
