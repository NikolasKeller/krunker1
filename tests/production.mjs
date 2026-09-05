import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
const origin = process.env.GAME_URL ?? 'http://127.0.0.1:8080';
const html = await (await fetch(origin)).text();
assert.match(html, /<canvas id="game">/);
const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map(m => m[1]);
for (const asset of [...assets, '/fonts/barlow.ttf', '/fonts/barlow-bold.ttf', '/fonts/barlow-condensed.ttf', '/favicon.svg']) {
    const response = await fetch(origin + asset);
    assert.equal(response.status, 200, asset);
    assert.ok((await response.arrayBuffer()).byteLength > 100);
}
console.log('PASS: production HTML, JS, CSS and self-hosted assets on PORT=8080');
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
        this.phase = m.round.phase;
    } if (m.type === 'events')
        this.events.push(...m.events); }); }
    send(m) { if (this.ws.readyState === 1)
        this.ws.send(JSON.stringify(m)); }
    get p() { return this.players.get(this.id); }
    start(targetZ) { const p = this.p; const side = Math.abs(p.x) > 25 ? Math.sign(p.x) * 35 : p.x; const edge = targetZ === 12 ? 34 : -34; this.waypoints = [[side, p.z], [side, edge], [35, edge], [35, targetZ]]; let next = Date.now(); const loop = () => { const p = this.p; if (!p)
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
