// Export the real UI DOM/CSS for the external browser verifier. This script never launches a browser.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { UI } from '../src/client/ui';
import type { Network } from '../src/client/network';
import type { Renderer } from '../src/client/renderer';
import { Room } from '../src/server/simulation';
import type { GameEvent } from '../src/shared/types';
import { installDOM } from './dom';

const out = new URL('../artifacts/hud-preview/', import.meta.url);
await mkdir(out, { recursive: true });
let css = await readFile(new URL('../src/client/style.css', import.meta.url), 'utf8');
for (const match of css.matchAll(/url\('(?<path>\/fonts\/[^']+)'\)/g)) {
    const bytes = await readFile(new URL(`../public${match.groups!.path}`, import.meta.url));
    css = css.replace(match[0], `url('data:font/ttf;base64,${bytes.toString('base64')}')`);
}
const geometry = (await readFile(new URL('../artifacts/geometry-preview.png', import.meta.url))).toString('base64');
for (const state of ['lobby', 'ffa', 'tdm', 'body-hit', 'headshot', 'multikill'] as const) {
    const { dom, restore } = installDOM('https://furo.example');
    try {
        Object.defineProperty(dom.window, 'innerWidth', { value: 1024 });
        Object.defineProperty(dom.window, 'innerHeight', { value: 614 });
        const room = new Room('PROOF');
        const a = room.add('You', 'hunter', 'blue').state;
        const b = room.add('davidGE3', 'hunter', 'red').state;
        room.round.mode = state === 'ffa' ? 'ffa' : 'tdm';
        room.round.phase = state === 'lobby' ? 'lobby' : 'playing';
        room.round.endsAt = 139000;
        room.round.red = 13; room.round.blue = 17;
        const net = { id: a.id, host: a.id, room: room.id, status: 'CONNECTED', round: room.round,
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
        const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Furo HUD review: ${state}</title><style>${css}
body { background:#cdbfbe url(data:image/png;base64,${geometry}) center/cover no-repeat; }
#damage-numbers>span { animation-play-state:paused; animation-delay:-.15s; }
</style><body>${document.body.innerHTML}</body></html>`;
        await writeFile(new URL(`${state}.html`, out), html);
    } finally { restore(); }
}
console.log('Exported artifacts/hud-preview/{lobby,ffa,tdm,body-hit,headshot,multikill}.html');
console.log('Real UI markup, CSS and embedded font; frozen feedback over a software geometry preview. No browser screenshots taken.');
