import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import type { StartupScreen } from '../src/client/startup';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

test('initial HTML shows a branded loading indicator without executing any JavaScript or loading CSS/fonts', () => {
    const dom = new JSDOM(html);
    try {
        const doc = dom.window.document, screen = doc.getElementById('startup')!;
        assert.ok(screen, 'the loader must exist in index.html itself');
        assert.equal(screen.hidden, false);
        assert.match(screen.textContent!, /FURO/);
        assert.match(screen.textContent!, /Loading the lobby/);
        assert.ok(screen.querySelector('progress[value]'), 'determinate startup steps are present in initial markup');
        assert.equal(dom.window.getComputedStyle(screen).backgroundColor, 'rgb(22, 27, 32)');
        assert.notEqual(dom.window.getComputedStyle(screen).display, 'none');
        assert.equal(doc.querySelector('link[rel="stylesheet"]'), null, 'an external stylesheet must not block first paint');
        assert.ok(screen.querySelector('noscript'), 'JavaScript-disabled visitors get an explanation');
        assert.ok(screen.querySelector('#startup-reload'));
        assert.ok(doc.head.querySelector('script:not([src])'), 'failure handling precedes the module download');
    } finally { dom.window.close(); }
});

async function setup() {
    const timers = new Map<number, { fn: () => void; ms: number }>();
    let nextId = 0;
    const marks: string[] = [];
    const dom = new JSDOM(html, {
        url: 'https://furo.example/?room=FRND5', runScripts: 'dangerously',
        // jsdom executes only the inline guard; no module, browser, or WebGL is run.
        beforeParse(window) {
            window.setTimeout = ((fn: () => void, ms: number) => { timers.set(++nextId, { fn, ms }); return nextId; }) as typeof window.setTimeout;
            window.clearTimeout = id => { timers.delete(Number(id)); };
            window.performance.mark = ((name: string) => { marks.push(name); }) as typeof window.performance.mark;
        },
    });
    await new Promise<void>(resolve => dom.window.document.addEventListener('DOMContentLoaded', () => resolve()));
    const doc = dom.window.document;
    const startup = (dom.window as unknown as { __furoStartup: StartupScreen }).__furoStartup;
    return { dom, doc, startup, marks, runTimer(ms: number) {
        const entry = [...timers].find(([, timer]) => timer.ms === ms);
        assert.ok(entry, `expected ${ms}ms timer`);
        timers.delete(entry[0]); entry[1].fn();
    } };
}

test('room context, completed stages and fade follow actual lobby/game readiness', async () => {
    const { dom, doc, startup, marks, runTimer } = await setup();
    try {
        assert.equal(doc.getElementById('startup-room')!.textContent, 'Joining room FRND5');
        const screen = doc.getElementById('startup')!;
        startup.lobbyReady();
        assert.equal((doc.getElementById('startup-progress') as HTMLProgressElement).value, 2);
        assert.ok(screen.classList.contains('leaving'));
        assert.equal(screen.hidden, false, 'fade precedes hiding');
        runTimer(180);
        assert.equal(screen.hidden, true);
        startup.gameReady();
        assert.deepEqual(marks, ['furo-lobby-ready', 'furo-game-ready']);
        startup.fail(new Error('later gameplay error'));
        assert.equal(screen.hidden, true, 'startup handlers end after the first successful game frame');
    } finally { dom.window.close(); }
});

for (const asset of ['entry module', 'stylesheet']) test(`failed ${asset} shows reload without needing the app bundle`, async () => {
    const { dom, doc, startup } = await setup();
    try {
        const element = doc.createElement(asset === 'stylesheet' ? 'link' : 'script');
        if (element.tagName === 'LINK') element.setAttribute('rel', 'stylesheet');
        doc.head.append(element);
        element.dispatchEvent(new dom.window.Event('error'));
        assert.equal(startup.failed, true);
        assert.match(doc.getElementById('startup-detail')!.textContent!, /game file could not load/);
        assert.equal(doc.getElementById('startup-progress')!.hidden, true);
        assert.equal(doc.getElementById('startup-reload')!.hidden, false);
        assert.equal(doc.activeElement?.id, 'startup-reload');
        startup.lobbyReady(); startup.gameReady();
        assert.equal(doc.getElementById('startup')!.hidden, false, 'late successful requests cannot dismiss an error');
    } finally { dom.window.close(); }
});

test('WebGL failure after lobby paint reopens the same screen with the existing explanation', async () => {
    const { dom, doc, startup, runTimer } = await setup();
    try {
        startup.lobbyReady(); runTimer(180);
        startup.fail(new Error('WebGL could not start'));
        assert.equal(doc.getElementById('startup')!.hidden, false);
        assert.equal(doc.getElementById('startup')!.classList.contains('leaving'), false);
        assert.equal(doc.getElementById('startup-detail')!.textContent, 'WebGL could not start. Enable hardware acceleration in your browser and reload.');
        assert.equal(doc.getElementById('startup-reload')!.hidden, false);
    } finally { dom.window.close(); }
});

test('initialisation exceptions, rejected imports and stalled downloads have a finite failure path', async () => {
    for (const failure of ['exception', 'rejection', 'timeout']) {
        const { dom, doc, startup, runTimer } = await setup();
        try {
            if (failure === 'exception') dom.window.dispatchEvent(new dom.window.ErrorEvent('error', { error: new Error('initialisation failed') }));
            if (failure === 'rejection') {
                const event = new dom.window.Event('unhandledrejection');
                Object.defineProperty(event, 'reason', { value: new Error('import failed') });
                dom.window.dispatchEvent(event);
            }
            if (failure === 'timeout') runTimer(90000);
            assert.equal(startup.failed, true, failure);
            assert.equal(doc.getElementById('startup-reload')!.hidden, false, failure);
        } finally { dom.window.close(); }
    }
});
