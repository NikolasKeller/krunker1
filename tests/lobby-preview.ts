// Export the real lobby DOM and CSS for external screenshot review. No browser required.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { UI } from '../src/client/ui';
import type { Network } from '../src/client/network';
import { Room } from './sandyard-room';
import { CLASS_IDS } from '../src/shared/weapons';
import { installDOM } from './dom';

const out = new URL('../artifacts/lobby-preview/', import.meta.url);
await mkdir(out, { recursive: true });
let css = await readFile(new URL('../src/client/style.css', import.meta.url), 'utf8');
for (const match of css.matchAll(/url\('(?<path>\/fonts\/[^']+)'\)/g)) {
    const font = await readFile(new URL(`../public${match.groups!.path}`, import.meta.url));
    css = css.replace(match[0], `url('data:font/ttf;base64,${font.toString('base64')}')`);
}
const geometry = (await readFile(new URL('../artifacts/geometry-preview.png', import.meta.url))).toString('base64');
const states = ['lobby', 'ffa', 'full-room', 'unbalanced', 'empty-team', 'create', 'late-join', 'results'] as const;
for (const state of states) {
    const { restore } = installDOM('https://furo.example/?room=FRND5');
    try {
        const room = new Room('FRND5');
        const full = state === 'full-room' || state === 'unbalanced';
        const humans = state === 'create' ? 0 : state === 'empty-team' ? 1 : full ? 10 : 6;
        const bots = full ? 7 : humans > 1 ? 2 : 0;
        const names = ['Niko', 'Ada', 'Mio', 'Jules', 'Robin', 'Sam', 'LongCallsign1234', 'Luca', 'Sasha', 'Noa', 'Kilo', 'Mochi', 'Rook', 'Pixel', 'Echo', 'Noodle', 'Orbit'];
        const players = Array.from({ length: humans + bots }, (_, i) => {
            const bot = i >= humans;
            const p = room.add(names[bot ? 10 + i - humans : i], CLASS_IDS[i % 4], state === 'unbalanced' || i % 2 === 0 ? 'blue' : 'red', bot).state;
            p.id = `player-${String(i).padStart(2, '0')}`;
            p.ready = !bot && i !== 3 && i !== 5;
            return p;
        });
        room.round.mode = state === 'ffa' || state === 'create' ? 'ffa' : 'tdm';
        room.round.phase = state === 'late-join' ? 'playing' : state === 'results' ? 'results' : 'lobby';
        if (state === 'results') {
            room.round.winner = 'BLUE'; room.round.nextAt = 8000;
            room.round.results = players.map((p, i) => ({ ...p, kills: 10 - i, deaths: i, score: 1000 - i * 100 }));
        }
        if (state === 'late-join' || state === 'results') players.forEach(p => p.ready = false);
        const local = players[state === 'late-join' ? 5 : 0];
        const net = { id: local?.id ?? '', host: players[0]?.id ?? '', room: humans ? room.id : '', ws: humans ? {} : undefined,
            status: humans ? 'CONNECTED' : 'CREATE OR JOIN A LOBBY', round: humans ? room.round : undefined,
            players: new Map(players.map(p => [p.id, p])), local, serverNow: 1000, difficulty: 'normal', bots, send() {} } as unknown as Network;
        const ui = new UI(net);
        if (local) ui.choose(local.classId, false);
        const originalFetch = globalThis.fetch;
        try {
            globalThis.fetch = async () => Response.json({ publicUrl: location.origin, lan: [] });
            if (humans) await ui.welcomed();
        } finally { globalThis.fetch = originalFetch; }
        ui.updateLobby();
        for (const field of document.querySelectorAll('input')) field.setAttribute('value', field.value);
        for (const field of document.querySelectorAll('select')) for (const option of field.options) option.toggleAttribute('selected', option.selected);
        await writeFile(new URL(`${state}.html`, out), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Furo lobby review · ${state}</title><style>${css}\nbody { background:#cdbfbe url(data:image/png;base64,${geometry}) center/cover fixed no-repeat; }</style></head><body>${document.body.innerHTML}</body></html>`);
    } finally { restore(); }
}
await writeFile(new URL('README.md', out), `Generated with npm run preview:lobby from the real UI, using embedded fonts and CSS.\n\nScreenshot lobby.html and ffa.html at 1280×800 and 1440×900. Also check full-room.html and unbalanced.html for scroll and pinned readiness, empty-team.html, create.html, late-join.html and results.html. Pages are static layout fixtures; live controls are covered by DOM and WebSocket tests.\n`);
console.log(`Exported artifacts/lobby-preview/{${states.join(',')}}.html (self-contained; no browser launched).`);
