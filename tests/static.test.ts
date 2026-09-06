import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { serveClient } from '../src/server/static';

test('production assets negotiate precompressed bytes, WASM MIME, immutable caching and revalidation', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'furo-static-'));
    const app = http.createServer((req, res) => { void serveClient(req, res, root); });
    try {
        await mkdir(path.join(root, 'assets'));
        const body = '/* a hashed game asset */\n'.repeat(1000);
        for (const extension of ['js', 'css', 'wasm']) await writeFile(path.join(root, `assets/game-abc12345.${extension}`), body);
        await writeFile(path.join(root, 'index.html'), '<!doctype html><p>Loading Furo</p>'.repeat(100));
        await promisify(execFile)(process.execPath, ['scripts/compress-client.mjs', root]);
        await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
        const address = app.address(); assert.ok(address && typeof address !== 'string');
        const origin = `http://127.0.0.1:${address.port}`;
        const request = (url: string, headers: Record<string, string> = {}, method = 'GET') => new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
            http.get(origin + url, { headers, method }, response => {
                const chunks: Buffer[] = [];
                response.on('data', data => chunks.push(data));
                response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks) }));
                response.on('error', reject);
            }).on('error', reject);
        });
        for (const extension of ['js', 'css', 'wasm']) {
            const url = `/assets/game-abc12345.${extension}`;
            for (const encoding of ['br', 'gzip', 'identity']) {
                const response = await request(url, { 'accept-encoding': encoding });
                assert.equal(response.status, 200);
                assert.equal(response.headers['content-encoding'], encoding === 'identity' ? undefined : encoding);
                assert.equal(response.headers['vary'], 'Accept-Encoding');
                assert.equal(response.headers['cache-control'], 'public, max-age=31536000, immutable');
                assert.equal(Number(response.headers['content-length']), response.body.length);
                if (extension === 'wasm') assert.equal(response.headers['content-type'], 'application/wasm');
                const decoded = encoding === 'br' ? brotliDecompressSync(response.body) : encoding === 'gzip' ? gunzipSync(response.body) : response.body;
                assert.equal(decoded.toString(), body);
                if (encoding !== 'identity') {
                    const sidecar = await readFile(path.join(root, `${url}.${encoding === 'br' ? 'br' : 'gz'}`));
                    assert.deepEqual(response.body, sidecar);
                    assert.ok(response.body.length < Buffer.byteLength(body));
                }
                const cached = await request(url, { 'accept-encoding': encoding, 'if-none-match': response.headers.etag! });
                assert.equal(cached.status, 304); assert.equal(cached.body.length, 0);
                const head = await request(url, { 'accept-encoding': encoding }, 'HEAD');
                assert.equal(head.status, 200); assert.equal(head.body.length, 0);
                assert.equal(head.headers['content-length'], response.headers['content-length']);
            }
        }
        const url = '/assets/game-abc12345.js';
        assert.equal((await request(url, { 'accept-encoding': 'gzip, br' })).headers['content-encoding'], 'br');
        assert.equal((await request(url, { 'accept-encoding': 'br;q=0, gzip' })).headers['content-encoding'], 'gzip');
        assert.equal((await request(url, { 'accept-encoding': 'br;q=0.2, gzip;q=0.8' })).headers['content-encoding'], 'gzip');
        assert.equal((await request(url, { 'accept-encoding': 'br;q=0, gzip;q=0' })).headers['content-encoding'], undefined);
        const page = await request('/?room=FRND5', { 'accept-encoding': 'br' });
        assert.equal(page.headers['cache-control'], 'no-cache');
        assert.equal(page.headers['content-encoding'], 'br');
        assert.equal((await request('/assets/missing.js')).status, 404, 'missing chunks cannot fall through to HTML');
        assert.equal((await request('/%ZZ')).status, 400);
        assert.equal((await request('/..%2Foutside.js')).status, 403);
    } finally {
        app.closeAllConnections();
        await new Promise<void>(resolve => app.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
    }
});
