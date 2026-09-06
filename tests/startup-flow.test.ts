import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import type { Network } from '../src/client/network';
import type { UI } from '../src/client/ui';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const bundle = await build({
    entryPoints: ['src/client/lobby-app.ts'], bundle: true, write: false, format: 'iife', globalName: 'lobbyTest',
    loader: { '.css': 'empty' }, define: { 'import.meta.env.DEV': 'false' },
    plugins: [{ name: 'deferred-game', setup(builder) {
        builder.onResolve({ filter: /^\.\/game$/ }, () => ({ path: 'deferred-game', namespace: 'test' }));
        builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: `
            if (globalThis.importFailure) throw new Error('Game chunk failed');
            export const startGame = (...args) => globalThis.startTestGame(...args);
        ` }));
    } }],
});

for (const scenario of ['delayed game', 'failed chunk', 'failed first frame']) test(`startup orchestration: ${scenario}`, async () => {
    const frames: FrameRequestCallback[] = [];
    let finishGame!: () => void;
    const gameReady = new Promise<void>(resolve => { finishGame = resolve; });
    let game: { net: Network; ui: UI } | undefined;
    const currentGame = () => game;
    const marks: string[] = [];
    const dom = new JSDOM(html, {
        url: 'http://localhost:8089', runScripts: 'dangerously',
        beforeParse(window) {
            window.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
            window.performance.mark = ((name: string) => { marks.push(name); }) as typeof window.performance.mark;
            Object.assign(window, {
                TextEncoder, TextDecoder, importFailure: scenario === 'failed chunk',
                startTestGame(net: Network, ui: UI) {
                    game = { net, ui };
                    if (scenario === 'failed first frame') throw new Error('First render failed');
                    return gameReady;
                },
            });
        },
    });
    try {
        await new Promise<void>(resolve => dom.window.document.addEventListener('DOMContentLoaded', () => resolve()));
        const boot = dom.window.eval(bundle.outputFiles[0].text + '\nlobbyTest.startLobby();') as Promise<void>;
        const doc = dom.window.document;
        assert.ok(doc.querySelector('.room-panel'), 'actual UI is available before the game import');
        assert.equal(game, undefined);
        (doc.querySelector('[data-class="vince"]') as HTMLButtonElement).click();
        assert.equal(doc.querySelector('.class-card.selected strong')!.textContent, 'VINCE');
        assert.equal((doc.getElementById('create-room') as HTMLButtonElement).disabled, false);
        frames.shift()!(0);
        assert.deepEqual(marks, ['furo-lobby-ready']);
        assert.equal(game, undefined, 'renderer import waits until after the lobby paint');
        frames.shift()!(16);
        // Allow the real dynamic-import continuation to evaluate the test game chunk.
        await new Promise(resolve => setTimeout(resolve, 0));
        if (scenario === 'delayed game') {
            const started = currentGame();
            assert.ok(started);
            assert.equal(started.ui.selected, 'vince', 'class chosen during download survives initialization');
            assert.equal(started.ui.gameReady, false);
            assert.deepEqual(marks, ['furo-lobby-ready'], 'download completion alone does not enable play');
            finishGame(); await boot;
            assert.equal(started.ui.gameReady, true);
            assert.deepEqual(marks, ['furo-lobby-ready', 'furo-game-ready']);
        } else {
            await boot;
            assert.equal(doc.getElementById('startup')!.hidden, false);
            assert.equal(doc.getElementById('startup-reload')!.hidden, false);
            assert.match(doc.getElementById('startup-detail')!.textContent!, /could not initialise/);
            assert.deepEqual(marks, ['furo-lobby-ready']);
        }
    } finally { game?.net.disconnect(); dom.window.close(); }
});
