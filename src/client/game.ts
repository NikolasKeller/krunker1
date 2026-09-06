import { Controls } from './input';
import type { Network } from './network';
import { ShotFeedback } from './shot-feedback';
import { previewInput } from './prediction';
import { Renderer } from './renderer';
import { AudioEngine } from './audio';
import type { UI } from './ui';
import { wireInput } from '../shared/protocol';
import { STEP, type Input, type WeaponId } from '../shared/types';
import { WEAPONS } from '../shared/weapons';
import { clamp, distance } from '../shared/math';
// Lobby/network ownership stays in lobby-app; only gameplay waits for Three.js.
export function startGame(net: Network, ui: UI, canvas: HTMLCanvasElement): Promise<void> {
    const audio = new AudioEngine(), controls = new Controls(canvas);
    const renderer = new Renderer(canvas);
    const shots = new ShotFeedback(renderer.effects, renderer.viewmodel, audio);
    renderer.setClass(ui.selected);
    renderer.setQuality(localStorage.getItem('arena-quality') ?? 'balanced');
    let playing = false, nextShot = 0, shotIndex = 0, lastShot = 0, lastLife = -1, lastWeapon: WeaponId = 'sniper', previousReload = 0, lastStep = 0, lastTime = performance.now(), accumulator = 0;
    ui.onClass = id => { renderer.setClass(id); };
    ui.onRoom = () => { playing = false; ui.menu = true; ui.paused = false; ui.visibility(); document.exitPointerLock(); net.connect(ui.joinConfig); };
    const deploy = () => {
        audio.unlock();
        ui.menu = false;
        ui.paused = false;
        playing = true;
        ui.visibility();
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
    controls.onChat = () => ui.focusChat();
    controls.onPause = () => { if (!controls.locked && playing && !ui.menu) {
        ui.paused = true;
        ui.visibility();
    } };
    net.onNotice = text => ui.notice(text);
    net.onChat = message => ui.chat(message);
    let phase = '';
    let pendingFireAim: Pick<Input, 'seq' | 'yaw' | 'pitch' | 'shotTime'> | undefined;
    const welcomed = net.onWelcome;
    net.onWelcome = () => { shots.clear(); nextShot = 0; lastLife = -1; phase = ''; welcomed(); };
    net.onEvents = events => {
        for (const e of events) {
            ui.event(e, renderer, performance.now());
            if (e.type === 'shot') {
                const own = e.shooter === net.id;
                const dist = net.predicted ? distance(e.origin, net.predicted) : 0;
                if (!own && dist < 75)
                    audio.shot(e.weapon, dist);
                if (own) shots.confirm(e);
                else if (!ui.menu && e.weapon !== 'knife') {
                    for (const end of e.ends) {
                        renderer.effects.tracer(e.origin, end);
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
    function sampleInput(seq: number) {
        const input = controls.sample(seq, net.interpolation.playbackTime ?? net.serverNow - net.interpolationDelay);
        // A shot shown between physics ticks keeps its original aim on the next
        // command even though the camera recoil has already responded this frame.
        if (pendingFireAim?.seq === seq) Object.assign(input, pendingFireAim);
        if (!playing || ui.menu || net.round?.phase !== 'playing') {
            input.forward = 0; input.strafe = 0; input.jump = false;
            input.fire = false; input.slide = false; input.aim = false; input.reload = false;
        }
        return wireInput(input);
    }
    let firstFrame = true;
    let ready: () => void, failed: (error: unknown) => void;
    const started = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject; });
    function frame(time: number) {
        if (window.__furoStartup.failed) return;
        try {
            renderFrame(time);
            if (firstFrame) { firstFrame = false; ready(); }
            requestAnimationFrame(frame);
        } catch (error) {
            if (firstFrame) failed(error);
            else throw error;
        }
    }
    function renderFrame(time: number) {
        const dt = Math.min(0.05, (time - lastTime) / 1000);
        lastTime = time;
        accumulator = Math.min(0.1, accumulator + dt);
        const p = net.predicted, now = net.serverNow;
        const currentPhase = net.round?.phase ?? '';
        if (currentPhase !== phase) {
            phase = currentPhase;
            playing = phase === 'playing';
            ui.menu = !playing;
            ui.paused = playing && !controls.locked;
            ui.scoreOpen = false;
            if (!playing && controls.locked) document.exitPointerLock();
            ui.visibility();
        }
        if (p && p.life !== lastLife) {
            lastLife = p.life;
            shots.clear();
            pendingFireAim = undefined;
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
        let fireInput = sampleInput(net.seq + 1);
        while (accumulator >= STEP) {
            accumulator -= STEP;
            if (!net.predicted)
                continue;
            fireInput = sampleInput(++net.seq);
            net.input(fireInput);
            if (pendingFireAim?.seq === fireInput.seq) pendingFireAim = undefined;
        }
        if (p && playing && controls.locked && !controls.typing && !ui.menu && p.alive && net.round?.phase === 'playing') {
            if (controls.fire && now >= nextShot && p.reloadEnd <= now && (p.ammo > 0 || p.weapon === 'knife')) {
                const w = WEAPONS[p.weapon];
                nextShot = now + w.interval;
                if (now - lastShot > 450)
                    shotIndex = 0;
                lastShot = now;
                const recoil = shots.fire(p, fireInput, shotIndex++, renderer.viewmodel.aim, renderer.shotMuzzle(p, fireInput, net.correction));
                if (recoil) {
                    if (fireInput.seq > net.seq) pendingFireAim = { seq: fireInput.seq, yaw: fireInput.yaw, pitch: fireInput.pitch, shotTime: fireInput.shotTime };
                    controls.pitch = clamp(controls.pitch + recoil[0], -1.54, 1.54);
                    controls.yaw += recoil[1];
                }
            }
            if (p.grounded && Math.hypot(p.vx, p.vz) > 3 && time - lastStep > 280 && p.slide <= 0) {
                lastStep = time;
                audio.step();
            }
        }
        net.smoothCorrection(dt);
        const rendered = previewInput(net.predicted, sampleInput(net.seq + 1), playing, accumulator / STEP);
        const aim = controls.locked && controls.aim && !!p?.alive && p.reloadEnd <= now;
        const remotes = net.remotePlayers();
        renderer.render(dt, time / 1000, rendered, remotes, controls, net.correction, ui.menu, aim, now, net.round?.mode ?? 'ffa');
        ui.update(time, renderer, aim, remotes);
    }
    requestAnimationFrame(frame);
    // Read-only diagnostics for external browser verification; no server debug commands are exposed.
    Object.defineProperty(window, '__arena', { value: { get metrics() { const errors = [...net.correctionDistances].sort((a, b) => a - b); return { fps: renderer.fps, ping: net.ping, drawCalls: renderer.drawCalls, triangles: renderer.triangles, pendingInputs: net.pending.length, predictionInputs: net.predictionHistory.pending.length, reconciliations: net.reconciliations, correctionP50: errors[Math.floor((errors.length - 1) * .5)] ?? 0, correctionP95: errors[Math.floor((errors.length - 1) * .95)] ?? 0, maxCorrection: net.maxCorrection, maxFrameCorrection: net.maxFrameCorrection, interpolationDelay: net.interpolationDelay, receivedBytes: net.bytes, connection: net.status, lobby: ui.lobby.metrics }; }, get state() { return { id: net.id, room: net.room, local: net.local, predicted: net.predicted, round: net.round, players: [...net.players.values()] }; } } });

    return started;
}
