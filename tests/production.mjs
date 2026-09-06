import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const origin = process.env.GAME_URL ?? 'http://127.0.0.1:8080';
const page = await fetch(origin);
assert.equal(page.status, 200);
const html = await page.text();
const railway = JSON.parse(await readFile(new URL('../railway.json', import.meta.url), 'utf8'));
const healthcheck = await fetch(origin + railway.deploy.healthcheckPath);
assert.equal(healthcheck.status, 200);
assert.equal((await healthcheck.json()).ok, true);
const connection = await (await fetch(origin + '/api/connection')).json();
assert.ok(Array.isArray(connection.lan));
assert.match(html, /<canvas id="game">/);
assert.match(html, /id="startup-progress"/);
assert.match(html, /id="startup-reload"/);
assert.doesNotMatch(html, /<link[^>]+rel="stylesheet"/, 'first paint must not wait for external CSS');
const manifest = await (await fetch(origin + '/.vite/manifest.json')).json();
const assets = [...new Set(Object.values(manifest).flatMap(chunk => ['/' + chunk.file, ...(chunk.css ?? []).map(file => '/' + file)]))];
for (const asset of [...assets, '/fonts/squada-one.ttf', '/favicon.svg']) {
    const response = await fetch(origin + asset, { headers: { 'accept-encoding': 'br' } });
    assert.equal(response.status, 200, asset);
    assert.ok((await response.arrayBuffer()).byteLength > 100);
    assert.equal(response.headers.get('content-encoding'), 'br', asset);
    assert.equal(response.headers.get('vary'), 'Accept-Encoding', asset);
    if (asset.startsWith('/assets/')) {
        assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
        const cached = await fetch(origin + asset, { headers: { 'accept-encoding': 'br', 'if-none-match': response.headers.get('etag') } });
        assert.equal(cached.status, 304, asset);
    }
}
console.log(`PASS: initial loader, split JS/CSS, Brotli and hashed-asset caching at ${origin}`);
const wait = async (fn, label, ms = 5000) => { const t = Date.now(); while (!fn()) {
    if (Date.now() - t > ms)
        throw new Error(label);
    await delay(20);
} };
const room = 'PROD-' + Date.now().toString(36).toUpperCase();
class Client {
    ws = new WebSocket(origin.replace('http', 'ws') + '/ws');
    id = '';
    players = new Map();
    phase = '';
    seq = 0;
    events = [];
    waypoints = [];
    shoot = false;
    timer;
    constructor(name) { this.ws.addEventListener('open', () => this.send({ type: 'join', name, room, classId: 'hunter', team: name === 'Alpha' ? 'blue' : 'red' })); this.ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.type === 'welcome')
        this.id = m.id; if (m.type === 'snapshot') {
        if (m.full)
            this.players.clear();
        for (const p of m.players)
            this.players.set(p.id, { ...this.players.get(p.id), ...p });
        for (const id of m.removed)
            this.players.delete(id);
        if (m.round) this.phase = m.round.phase;
    } if (m.type === 'events')
        this.events.push(...m.events); }); }
    send(m) { if (this.ws.readyState === 1)
        this.ws.send(JSON.stringify(m)); }
    get p() { return this.players.get(this.id); }
    // The z=±34 lamp posts are solid; the outer lane at ±36 is clear.
    start(targetZ) { const p = this.p; const side = Math.abs(p.x) > 25 ? Math.sign(p.x) * 35 : p.x; const edge = targetZ === 12 ? 36 : -36; this.waypoints = [[side, p.z], [side, edge], [35, edge], [35, targetZ]]; let next = Date.now(); const loop = () => { const p = this.p; if (!p)
        return; while (this.waypoints.length && Math.hypot(this.waypoints[0][0] - p.x, this.waypoints[0][1] - p.z) < .7)
        this.waypoints.shift(); const goal = this.waypoints[0]; const target = [...this.players.values()].find(q => q.id !== this.id && !q.bot); let yaw = goal ? Math.atan2(-(goal[0] - p.x), -(goal[1] - p.z)) : target ? Math.atan2(-(target.x - p.x), -(target.z - p.z)) : 0; const pitch = target ? Math.atan2(target.y + 1.58 - (p.y + 1.62), Math.hypot(target.x - p.x, target.z - p.z)) : 0; this.send({ type: 'input', inputs: [{ seq: ++this.seq, forward: goal ? 1 : 0, strafe: 0, yaw, pitch, jump: false, slide: false, fire: this.shoot, aim: !goal, reload: false, slot: 1, shotTime: Date.now() - 100 }] }); next += 1000 / 60; this.timer = setTimeout(loop, Math.max(0, next - Date.now())); }; loop(); }
    close() { clearTimeout(this.timer); this.ws.close(); }
}
const a = new Client('Alpha'), b = new Client('Bravo');
try {
    await wait(() => a.p && b.p, 'join');
    a.send({ type: 'configure', bots: 0 });
    a.send({ type: 'start' });
    await wait(() => a.phase === 'playing' && b.phase === 'playing', 'start');
    a.start(12);
    b.start(0);
    await wait(() => a.waypoints.length === 0 && b.waypoints.length === 0, 'navigate to firing lane', 25000);
    await delay(500);
    assert.ok(Math.abs(a.p.x - 35) < 1.5);
    assert.ok(Math.abs(b.players.get(a.id).z - a.p.z) < .3);
    a.shoot = true;
    await wait(() => a.events.some(e => e.type === 'kill' && e.killer === a.id && e.victim === b.id), 'real-client production kill');
    a.shoot = false;
    assert.ok(b.events.some(e => e.type === 'kill' && e.victim === b.id));
    console.log('PASS: two independent production clients navigate using inputs and register a headshot kill');
    await wait(() => b.p.alive, 'production respawn');
    const health = await (await fetch(origin + '/api/health')).json();
    console.log('PRODUCTION METRICS', JSON.stringify(health));
    assert.ok(health.tickRate > 55);
}
finally {
    a.close();
    b.close();
}
