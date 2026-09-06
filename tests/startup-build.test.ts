import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';

test('production first paint and lobby exclude the renderer and physics WASM', async () => {
    const result = await build({ logLevel: 'silent', build: { write: false } });
    assert.ok(!Array.isArray(result) && 'output' in result);
    const chunks = result.output.filter(output => output.type === 'chunk');
    const entry = chunks.find(chunk => chunk.isEntry)!;
    const lobby = chunks.find(chunk => chunk.name === 'lobby-app')!;
    const game = chunks.find(chunk => chunk.name === 'game')!;
    assert.ok(entry && lobby && game, 'startup, lobby and game must be separate chunks');
    assert.ok(Buffer.byteLength(entry.code) < 4096, 'entry bootstrap stays small');
    const staticDependencies = (file: string, seen = new Set<string>()): Set<string> => {
        if (seen.has(file)) return seen;
        seen.add(file);
        const chunk = chunks.find(chunk => chunk.fileName === file)!;
        for (const dependency of chunk.imports) staticDependencies(dependency, seen);
        return seen;
    };
    for (const chunk of [entry, lobby]) {
        const dependencies = [...staticDependencies(chunk.fileName)].map(file => chunks.find(c => c.fileName === file)!);
        const modules = dependencies.flatMap(c => Object.keys(c.modules));
        assert.ok(!modules.some(module => /node_modules\/three\/|client\/(renderer|game)\.ts/.test(module)), `${chunk.name} must not wait for Three.js or game setup`);
    }
    assert.ok(entry.dynamicImports.includes(lobby.fileName));
    assert.ok(lobby.dynamicImports.includes(game.fileName));
    assert.ok(!chunks.some(chunk => Object.keys(chunk.modules).some(module => /rapier|\.wasm/.test(module))), 'Rapier is a types-only dependency; do not ship it');
    const page = result.output.find(output => output.type === 'asset' && output.fileName === 'index.html');
    assert.ok(page?.type === 'asset');
    const html = String(page.source);
    assert.match(html, /id="startup-progress"/);
    assert.doesNotMatch(html, /<link[^>]+rel="(?:stylesheet|modulepreload)"/, 'Vite must not introduce render-blocking CSS or renderer preloads into HTML');
});
