// Self-contained, production DOM/CSS fixtures. Rendering belongs to the calling agent.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { createTextLayoutFixture, layoutStates, layoutViewports } from './text-layout-fixture';

const out = new URL('../artifacts/text-layout/', import.meta.url);
await mkdir(out, { recursive: true });
let css = await readFile(new URL('../src/client/style.css', import.meta.url), 'utf8');
for (const match of css.matchAll(/url\('(?<path>\/fonts\/[^']+)'\)/g)) {
    const font = await readFile(new URL(`../public${match.groups!.path}`, import.meta.url));
    css = css.replace(match[0], `url('data:font/ttf;base64,${font.toString('base64')}')`);
}
const bundle = await build({ entryPoints: ['tests/text-layout-preview-client.ts'], bundle: true, write: false, format: 'iife', minify: true });
const script = bundle.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
for (const state of layoutStates) for (const touch of [false, true]) {
    const fixture = createTextLayoutFixture(state, touch);
    try {
        await writeFile(new URL(`${state}${touch ? '-touch' : ''}.html`, out), `<!doctype html><html lang="en" class="${document.documentElement.className}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>Furo text layout · ${state}</title><style>${css}</style></head><body>${document.body.innerHTML}<script>${script}</script></body></html>`);
    } finally { fixture.restore(); }
}
// The matrix supplies real viewport sizes via iframes without any browser automation dependency.
const cases = layoutStates.flatMap(state => layoutViewports.map(viewport => ({ state, ...viewport, file: `${state}${viewport.touch ? '-touch' : ''}.html` })));
await writeFile(new URL('index.html', out), `<!doctype html><html lang="en"><meta charset="utf-8"><title>Text layout regression matrix</title><style>body{font:16px system-ui;background:#161b20;color:#eee;margin:24px}a{color:#c7f451}iframe{display:block;border:0;margin-bottom:32px}pre{white-space:pre-wrap}</style><h1>Text layout regression matrix</h1><p>Real components and fonts at each viewport. Each frame measures its text after font loading. Scroll within lobby panels to review all cards.</p><pre id="report">Waiting for layouts…</pre>${cases.map(({ state, width, height, file }) => `<h2><a href="${file}">${state} · ${width} × ${height}</a></h2><iframe title="${state} ${width} × ${height}" src="${file}" width="${width}" height="${height}"></iframe>`).join('')}<script>
const matrix = window.__textLayoutMatrix = { ready: false, reports: [], assert() { if (!this.ready) throw Error('Matrix is not ready'); const failures = this.reports.filter(r => r.failures.length); if (failures.length) throw Error(JSON.stringify(failures, null, 2)); return this.reports; } };
const poll = setInterval(() => { const frames = [...document.querySelectorAll('iframe')]; if (!frames.every(f => f.contentWindow.__textLayout?.ready)) return; clearInterval(poll); matrix.reports = frames.map(f => ({ name: f.title, ...f.contentWindow.__textLayout.report })); matrix.ready = true; document.getElementById('report').textContent = JSON.stringify(matrix.reports, null, 2); document.documentElement.dataset.textLayout = matrix.reports.some(r => r.failures.length) ? 'fail' : 'pass'; }, 100);
</script></html>`);
console.log('Generated artifacts/text-layout/index.html and 10 embedded-font fixtures; no browser launched.');
