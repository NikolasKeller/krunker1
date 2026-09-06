// Execute the production game loop in a DOM, replacing only GPU/audio devices.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { Room } from './sandyard-room';
import type { Network } from '../src/client/network';
import type { UI } from '../src/client/ui';
const bundle = await build({
    stdin: { contents: "export { startGame } from './src/client/game'; export { Network } from './src/client/network'; export { UI } from './src/client/ui';", resolveDir: process.cwd() },
    bundle: true, format: 'iife', globalName: 'GameFixture', write: false,
    define: { 'import.meta.env.DEV': 'false' },
    plugins: [{ name: 'devices', setup(builder) {
        builder.onResolve({ filter: /^\.\/(renderer|audio)$/ }, args => ({ path: args.path, namespace: 'device-fixture' }));
        builder.onLoad({ filter: /.*/, namespace: 'device-fixture' }, args => ({ contents: args.path === './audio' ? `
            export class AudioEngine { unlock(){} setVolume(){} shot(){} hit(){} hurt(){} spawn(){} reload(){} step(){} }
        ` : `
            export class Renderer {
                fps=60; drawCalls=1; triangles=0; gl={getPixelRatio:()=>1};
                effects={tracer(){},impact(){return {visible:true}},shell(){},correctImpact(){},particles(){}};
                viewmodel={aim:0,weapon:'rifle',fire(){},setWeapon(w){this.weapon=w}};
                setClass(){} setQuality(){} setTouch(){} setResolutionScale(){} damage(){}
                shotMuzzle(p){return {x:p.x,y:p.y+1.62,z:p.z}}
                project(){return {visible:false,x:0,y:0}}
                render(dt,time,p){globalThis.renderedReload=p?.reloadEnd;}
                renderHome(){globalThis.homeRendered=true;}
            }
        ` }));
    } }],
});
for (const touch of [false, true]) for (const rtt of [0, 350]) test(`${touch ? 'touch invite' : 'desktop'} production loop at ${rtt} ms RTT: first-frame ammo/reload and correct startup`, async () => {
    let now = 0, requests = 0;
    const frames: FrameRequestCallback[] = [];
    const dom = new JSDOM('<canvas id="game"></canvas><div id="ui"></div>', { url: 'https://furo.example/?room=PHONE', runScripts: 'dangerously' });
    const win = dom.window;
    Object.defineProperty(win.navigator, 'maxTouchPoints', { value: touch ? 5 : 0 });
    Object.defineProperty(win.performance, 'now', { value: () => now });
    Object.assign(win, { TextEncoder, TextDecoder, __furoStartup: { failed: false }, requestAnimationFrame: (cb: FrameRequestCallback) => frames.push(cb) });
    const canvas = win.document.getElementById('game') as HTMLCanvasElement;
    canvas.requestPointerLock = () => {
        requests++; Object.defineProperty(win.document, 'pointerLockElement', { configurable: true, value: canvas });
        win.document.dispatchEvent(new win.Event('pointerlockchange')); return Promise.resolve();
    };
    win.document.exitPointerLock = () => {};
    win.eval(bundle.outputFiles[0].text);
    const fixture = (win as any).GameFixture;
    const net: Network = new fixture.Network();
    try {
        const room = new Room('PHONE'); room.botCount = 0; const actor = room.add('Phone', 'triggerman', 'blue'); room.start(0);
        actor.state.ammo = 1; net.id = actor.state.id; net.room = 'PHONE'; net.round = room.round; net.predicted = { ...actor.state }; net.players.set(net.id, { ...actor.state });
        net.status = 'CONNECTED'; net.ping = rtt;
        Object.defineProperty(net, 'serverNow', { get: () => 1000 + now });
        const ui: UI = new fixture.UI(net);
        const ready = fixture.startGame(net, ui, canvas);
        const frame = (time: number) => { now = time; frames.shift()!(time); };
        frame(100); await ready;
        assert.equal(ui.paused, true);
        (win.document.getElementById('resume') as HTMLButtonElement).click();
        assert.equal(ui.paused, false); assert.equal(requests, touch ? 0 : 1);
        frame(400); // Spawn input grace has elapsed.
        const press = 400.01;
        if (touch) {
            const e = new win.Event('pointerdown', { bubbles: true, cancelable: true });
            Object.assign(e, { pointerId: 1, pointerType: 'touch', clientX: 660, clientY: 270 });
            win.document.querySelector('[data-touch=fire]')!.dispatchEvent(e);
        } else win.dispatchEvent(new win.MouseEvent('mousedown', { button: 0 }));
        frame(400 + 1000 / 60);
        assert.equal(win.document.getElementById('ammo')!.textContent, '0');
        assert.equal(win.document.getElementById('reload-prompt')!.textContent, 'RELOADING');
        assert.ok((win as any).renderedReload > net.serverNow, 'reload pose begins on the shot frame');
        assert.ok(now - press < 1000 / 60);
        const reload = net.predicted!.reloadEnd;
        frame(400 + 2000 / 60); assert.equal(net.predicted!.ammo, 0); assert.equal(net.predicted!.reloadEnd, reload);
        // Reconcile a delayed pre-shot snapshot, then a server disagreement.
        now += rtt;
        net.weapons.reconcile({ ...actor.state, ack: 0 }, net.predicted!);
        assert.equal(net.predicted!.ammo, 0); assert.equal(net.predicted!.reloadEnd, reload);
        net.weapons.reconcile({ ...actor.state, ack: net.seq }, net.predicted!);
        assert.equal(net.predicted!.ammo, 1); assert.equal(net.predicted!.reloadEnd, 0);
        (win.document.getElementById('leave-match') as HTMLButtonElement).click();
        frame(now + 100);
        assert.equal(ui.home, true); assert.equal(ui.menu, true); assert.equal(ui.paused, false);
        assert.equal((win as any).homeRendered, true, 'the production loop renders the home character after leaving');
        assert.equal(net.round, undefined); assert.equal(net.predicted, undefined);
        assert.equal(win.location.search, '');
    } finally { net.disconnect(); dom.window.close(); }
});
