import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, gzip, constants } from 'node:zlib';

const br = promisify(brotliCompress), gz = promisify(gzip);
// Compress at build time, so serving downloads never competes with simulation CPU.
async function compressDirectory(root) {
    for (const entry of await readdir(root, { withFileTypes: true })) {
        const file = path.join(root, entry.name);
        if (entry.isDirectory()) { await compressDirectory(file); continue; }
        if (!/\.(html|js|css|svg|json|ttf|wasm)$/.test(entry.name)) continue;
        const body = await readFile(file);
        const variants = await Promise.all([
            br(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }),
            gz(body, { level: 9 }),
        ]);
        for (const [i, extension] of ['br', 'gz'].entries()) {
            if (variants[i].length < body.length) await writeFile(`${file}.${extension}`, variants[i]);
        }
    }
}
await compressDirectory(path.resolve(process.argv[2] ?? 'dist/client'));
