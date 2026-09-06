import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const mime: Record<string, string> = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
    '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
    '.png': 'image/png', '.json': 'application/json', '.wasm': 'application/wasm',
};

function acceptedEncodings(header = '') {
    const weights = new Map(header.toLowerCase().split(',').map(part => {
        const [encoding, ...parameters] = part.trim().split(';');
        const q = parameters.map(p => p.trim()).find(p => p.startsWith('q='));
        const value = q ? Number(q.slice(2)) : 1;
        return [encoding, Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0];
    }));
    const weight = (encoding: string) => weights.get(encoding) ?? weights.get('*') ?? 0;
    return ['br', 'gzip'].filter(e => weight(e) > 0).sort((a, b) => weight(b) - weight(a));
}

export async function serveClient(req: IncomingMessage, res: ServerResponse, root: string) {
    let requestPath: string;
    try { requestPath = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname); }
    catch { res.writeHead(400); res.end(); return; }
    let file = path.resolve(root, '.' + requestPath);
    if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
    if (!path.extname(file)) file = path.join(root, 'index.html');
    try {
        let info = await stat(file);
        if (!info.isFile()) throw new Error('Not a file');
        let variant = file, encoding: string | undefined;
        for (const candidate of acceptedEncodings(req.headers['accept-encoding'])) {
            const compressed = `${file}.${candidate === 'gzip' ? 'gz' : 'br'}`;
            const compressedInfo = await stat(compressed).catch(() => undefined);
            if (compressedInfo?.isFile()) { variant = compressed; info = compressedInfo; encoding = candidate; break; }
        }
        const etag = `W/"${info.size.toString(16)}-${info.mtimeMs.toString(16)}-${encoding ?? 'identity'}"`;
        const headers: Record<string, string> = {
            'content-type': mime[path.extname(file)] ?? 'application/octet-stream',
            'cache-control': file.startsWith(path.join(root, 'assets') + path.sep) ? 'public, max-age=31536000, immutable' : 'no-cache',
            'x-content-type-options': 'nosniff', 'vary': 'Accept-Encoding', 'etag': etag,
        };
        if (encoding) headers['content-encoding'] = encoding;
        if (req.headers['if-none-match']?.split(',').some(value => value.trim() === etag || value.trim() === '*')) {
            res.writeHead(304, headers); res.end(); return;
        }
        headers['content-length'] = String(info.size);
        const body = req.method === 'HEAD' ? undefined : await readFile(variant);
        res.writeHead(200, headers); res.end(body);
    } catch {
        res.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-cache' });
        res.end('A game file could not be found. Reload the page to get the latest version.');
    }
}
