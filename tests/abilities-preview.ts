// Real production DOM/CSS fixtures; no browser process or CDP connection.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { installDOM } from './dom';
import { UI } from '../src/client/ui';
import { Room } from './sandyard-room';
import { CLASS_IDS } from '../src/shared/weapons';
import { ABILITIES } from '../src/shared/abilities';
import type { Network } from '../src/client/network';
import type { Renderer } from '../src/client/renderer';

const out = new URL('../artifacts/abilities/', import.meta.url);
await mkdir(out, { recursive: true });
const css = (await readFile(new URL('../src/client/style.css', import.meta.url), 'utf8')).replaceAll("'/fonts/", "'../../public/fonts/");
await writeFile(new URL('preview.css', out), css);
const fixtures: { name: string; width: number; height: number }[] = [];
for (const id of CLASS_IDS) for (const state of ['ready', 'active', 'cooldown']) for (const touch of [false, true]) {
    const { dom, restore } = installDOM('https://furo.example/?room=TOOLS');
    try {
        const width = touch ? 667 : 1024, height = touch ? 375 : 614;
        Object.defineProperty(dom.window, 'innerWidth', { value: width }); Object.defineProperty(dom.window, 'innerHeight', { value: height });
        const r = new Room('TOOLS'), p = r.add('You', id, 'blue').state; r.start(1000); r.round.endsAt = 151000;
        p.hp = 70;
        p.abilityReadyAt = state === 'ready' ? 0 : 11000 + ABILITIES[id].cooldown;
        p.abilityUntil = state === 'active' ? 11000 + ABILITIES[id].duration : 0;
        p.grenadeReadyAt = state === 'ready' ? 0 : 71000; p.grenadeUntil = state === 'active' ? 13200 : 0;
        const net = { id: p.id, host: p.id, room: r.id, status: 'CONNECTED', ws: {}, round: r.round, players: new Map([[p.id, p]]), local: p, predicted: p, serverNow: 12000,
            ping: 24, difficulty: 'normal', bots: 0, remotePlayers: () => [], send() {} } as unknown as Network;
        const renderer = { fps: 144, viewmodel: { aim: 0 }, project: () => ({ visible: true, x: width / 2 + 90, y: height / 2 }) } as unknown as Renderer;
        const ui = new UI(net); ui.showMatch(); ui.menu = false; ui.paused = false; ui.setTouchMode(touch); ui.visibility(); ui.update(12000, renderer, false, []);
        if (id === 'hunter' && state === 'active') { ui.event({ type: 'spot', viewer: p.id, life: p.life, points: [{ x: 34, y: 1, z: 20 }], until: 12500 }, renderer, 12000); ui.update(12001, renderer, false, []); }
        const name = `${id}-${state}-${touch ? 'mobile-667' : 'desktop-1024'}`; fixtures.push({ name, width, height });
        const html = `<!doctype html><html lang="en" class="${touch ? 'touch-device touch-playing' : ''}"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Furo · ${name}</title><link rel="stylesheet" href="preview.css"><style>body{background:#9b8f80 url('../arena-preview.png') center/cover no-repeat}#ui{display:block}</style><body>${document.getElementById('hud')!.outerHTML}${document.getElementById('touch-controls')!.outerHTML}</body></html>`;
        await writeFile(new URL(`${name}.html`, out), html);
    } finally { restore(); }
}
await writeFile(new URL('index.html', out), `<!doctype html><html lang="en"><meta charset="utf-8"><title>Furo ability HUD review</title><style>body{background:#202a30;color:#f6f1df;font:16px system-ui;margin:28px}a{color:#c7f451}iframe{display:block;border:1px solid #778078;margin:16px 0 32px;max-width:100%}select{font:inherit;padding:8px}</style><h1>Furo · decisive moments</h1><p>Production HUD and touch controls, frozen in ready, active and cooldown states. Q = class ability; G = shared grenade. These are DOM previews, not browser screenshots.</p><label>Review fixture <select id="fixture">${fixtures.map((f, n) => `<option value="${n}">${f.name}</option>`).join('')}</select></label><iframe id="view" title="HUD fixture"></iframe><p><a id="open">Open fixture at full size</a></p><script>const fixtures=${JSON.stringify(fixtures)};function show(){const f=fixtures[Number(document.getElementById('fixture').value)],v=document.getElementById('view');v.src=f.name+'.html';v.width=f.width;v.height=f.height;document.getElementById('open').href=v.src}document.getElementById('fixture').onchange=show;show()</script></html>`);
console.log(`Exported ${fixtures.length} production HUD fixtures to artifacts/abilities/index.html; no browser launched.`);
