import './style.css';
import { Controls } from './input';
import { Network } from './network';
import { Renderer } from './renderer';
import { AudioEngine } from './audio';
import { UI } from './ui';
import { STEP, INTERPOLATION_MS, type WeaponId } from '../shared/types';
import { CLASSES, recoilFor, WEAPONS } from '../shared/weapons';
import { clamp, distance } from '../shared/math';
const canvas = document.getElementById('game') as HTMLCanvasElement;
const net = new Network(), audio = new AudioEngine(), controls = new Controls(canvas), ui = new UI(net);
let renderer: Renderer;
try {
    renderer = new Renderer(canvas);
}
catch (error) {
    document.getElementById('ui')!.innerHTML = '<div style="padding:40px;background:#17252b;color:white;font:20px Arial;pointer-events:auto">WebGL could not start. Enable hardware acceleration in your browser and reload.</div>';
    throw error;
}
renderer.setClass(ui.selected);
renderer.setQuality(localStorage.getItem('arena-quality') ?? 'balanced');
let playing = false, nextShot = 0, shotIndex = 0, lastShot = 0, lastLife = -1, lastWeapon: WeaponId = 'sniper', previousReload = 0, lastStep = 0, lastTime = performance.now(), accumulator = 0;
ui.onClass = id => { renderer.setClass(id); };
ui.onRoom = () => { playing = false; net.connect(ui.joinConfig); };
const deploy = () => {
    if (!net.id || (!net.host && net.round?.phase === 'lobby'))
        return;
    const name = ui.joinConfig.name;
    if (net.local && name !== net.local.name) {
        net.connect(ui.joinConfig);
        ui.notice('Callsign updated. Deploy when connected.');
        return;
    }
    if (net.round?.phase === 'lobby') {
        if (net.host !== net.id)
            return;
        net.send({ type: 'start' });
    }
    net.send({ type: 'class', classId: ui.selected, team: ui.team });
    ui.menu = false;
    ui.paused = false;
    playing = true;
    ui.visibility();
    audio.unlock();
    controls.lock();
};
ui.onDeploy = deploy;
ui.onResume = () => { ui.paused = false; ui.visibility(); audio.unlock(); controls.lock(); };
ui.onSettings = (key, value) => { if (key === 'sensitivity') {
    controls.sensitivity = Number(value);
    localStorage.setItem('arena-sensitivity', value);
} if (key === 'volume')
    audio.setVolume(Number(value)); if (key === 'quality')
    renderer.setQuality(value); };
controls.onLock = locked => { if (playing && !ui.menu) {
    ui.paused = !locked;
    ui.visibility();
} };
controls.onScore = open => { ui.scoreOpen = open; };
controls.onPause = () => { if (!controls.locked && playing && !ui.menu) {
    ui.paused = true;
    ui.visibility();
} };
net.onNotice = text => ui.notice(text);
net.onWelcome = () => { nextShot = 0; lastLife = -1; };
net.onEvents = events => {
    for (const e of events) {
        ui.event(e, renderer, performance.now());
        if (e.type === 'shot') {
            const own = e.shooter === net.id;
            const dist = net.predicted ? distance(e.origin, net.predicted) : 0;
            if (!own && dist < 75)
                audio.shot(e.weapon, dist);
            if (!ui.menu) {
                for (const end of e.ends) {
                    const from = own ? { x: renderer.camera.position.x, y: renderer.camera.position.y - 0.16, z: renderer.camera.position.z } : e.origin;
                    renderer.effects.tracer(from, end, own);
                    if (e.weapon !== 'knife')
                        renderer.effects.impact(end, e.origin);
                }
            }
        }
        if (e.type === 'hit') {
            renderer.effects.particles(e.point, true, 8);
            if (e.shooter === net.id)
                audio.hit(e.zone === 'head', e.lethal);
            if (e.victim === net.id) {
                renderer.damage();
                audio.hurt();
            }
        }
    }
};
net.connect(ui.joinConfig);
function frame(time: number) {
    const dt = Math.min(0.05, (time - lastTime) / 1000);
    lastTime = time;
    accumulator = Math.min(0.1, accumulator + dt);
    const p = net.predicted, now = net.serverNow;
    if (p && p.life !== lastLife) {
        lastLife = p.life;
        controls.yaw = p.yaw;
        controls.pitch = p.pitch;
        controls.slot = 1;
        nextShot = now + 250;
        shotIndex = 0;
        audio.spawn();
    }
    if (p?.weapon !== lastWeapon && p) {
        lastWeapon = p.weapon;
        nextShot = Math.max(nextShot, now + 100);
        shotIndex = 0;
    }
    if (p?.reloadEnd && p.reloadEnd !== previousReload)
        audio.reload();
    previousReload = p?.reloadEnd ?? 0;
    while (accumulator >= STEP) {
        accumulator -= STEP;
        if (!net.predicted)
            continue;
        const input = controls.sample(++net.seq, net.serverNow - INTERPOLATION_MS);
        if (!playing || ui.menu || net.round?.phase !== 'playing') {
            input.forward = 0;
            input.strafe = 0;
            input.jump = false;
            input.fire = false;
            input.slide = false;
            input.aim = false;
            input.reload = false;
        }
        net.input(input);
    }
    if (p && playing && controls.locked && !ui.menu && p.alive && net.round?.phase === 'playing') {
        if (controls.fire && now >= nextShot && p.reloadEnd <= now && (p.ammo > 0 || p.weapon === 'knife')) {
            const w = WEAPONS[p.weapon];
            nextShot = now + w.interval;
            if (now - lastShot > 450)
                shotIndex = 0;
            lastShot = now;
            const recoil = recoilFor(p.weapon, shotIndex++);
            controls.pitch = clamp(controls.pitch + recoil[0], -1.54, 1.54);
            controls.yaw += recoil[1];
            renderer.viewmodel.fire();
            audio.shot(p.weapon);
            if (p.weapon !== 'knife')
                p.ammo = Math.max(0, p.ammo - 1);
        }
        if (p.grounded && Math.hypot(p.vx, p.vz) > 3 && time - lastStep > 280 && p.slide <= 0) {
            lastStep = time;
            audio.step();
        }
    }
    const c = net.correction;
    const decay = Math.exp(-dt * 18);
    c.x *= decay;
    c.y *= decay;
    c.z *= decay;
    const aim = controls.locked && controls.aim && !!p?.alive && p.reloadEnd <= now;
    renderer.render(dt, time / 1000, net.predicted, net.remotePlayers(), controls, c, ui.menu, aim, now, net.round?.mode ?? 'ffa');
    ui.update(time, renderer, aim);
    requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
// Read-only diagnostics for external browser verification; no server debug commands are exposed.
Object.defineProperty(window, '__arena', { value: { get metrics() { return { fps: renderer.fps, ping: net.ping, drawCalls: renderer.drawCalls, triangles: renderer.triangles, pendingInputs: net.pending.length, reconciliations: net.reconciliations, maxCorrection: net.maxCorrection, receivedBytes: net.bytes, connection: net.status }; }, get state() { return { id: net.id, room: net.room, local: net.local, predicted: net.predicted, round: net.round, players: [...net.players.values()] }; } } });
