import { Controls } from './input';
import type { Network } from './network';
import { ShotFeedback } from './shot-feedback';
import { predictInput } from './prediction';
import { LocalMotion } from './local-motion';
import { Renderer } from './renderer';
import { AudioEngine } from './audio';
import type { UI } from './ui';
import { wireInput } from '../shared/protocol';
import { type Input } from '../shared/types';
import { CLASSES, WEAPONS } from '../shared/weapons';
import { clamp, distance } from '../shared/math';
import { FrameBudget } from './frame-budget';
// Lobby/network ownership stays in lobby-app; only gameplay waits for Three.js.
export function startGame(net: Network, ui: UI, canvas: HTMLCanvasElement): Promise<void> {
    const audio = new AudioEngine(), controls = new Controls(canvas);
    const renderer = new Renderer(canvas, controls.touchMode);
    const shots = new ShotFeedback(renderer.effects, renderer.viewmodel, audio);
    renderer.setClass(ui.selected);
    renderer.setQuality(localStorage.getItem('arena-quality') ?? (controls.touchMode ? 'low' : 'balanced'));
    const budget = new FrameBudget(controls.touchMode);
    const motion = new LocalMotion();
    let spawnReadyAt = 0, lastCombatLog = 0;
    let playing = false, lastLife = -1, previousReload = 0, lastStep = 0, lastTime = performance.now();
    ui.onClass = id => { renderer.setClass(id); };
    ui.onNavigate = () => { playing = !ui.menu; controls.unlock(); controls.clear(); pendingFireAim = undefined; shots.clear(); };
    const deploy = () => {
        audio.unlock();
        ui.showMatch();
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
    } if (key === 'touch-sensitivity') { controls.touchSensitivity = Number(value); localStorage.setItem('arena-touch-sensitivity', value); } if (key === 'volume')
        audio.setVolume(Number(value)); if (key === 'quality')
        { budget.reset(); renderer.setQuality(value); } };
    controls.onLock = locked => { if (playing && !ui.menu) {
        ui.paused = !locked;
        ui.visibility();
    } };
    controls.onScore = open => { ui.scoreOpen = open; };
    ui.onOverlay = () => { if (playing) controls.unlock(); };
    controls.onMode = touch => { ui.setTouchMode(touch); budget.mobile = touch; budget.reset(); renderer.setResolutionScale(1); renderer.setTouch(touch); };
    ui.setTouchMode(controls.touchMode);
    controls.onPause = () => { if (!controls.locked && playing && !ui.menu) {
        ui.paused = true;
        ui.visibility();
    } };
    net.onNotice = text => ui.notice(text);
    let phase = '';
    const homeStage = document.getElementById('home-character')!;
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    let pendingFireAim: Input | undefined;
    const welcomed = net.onWelcome;
    net.onWelcome = () => { shots.clear(); spawnReadyAt = 0; lastLife = -1; phase = ''; welcomed(); };
    shots.onHit = e => { net.remoteHealth.predict(e, net.players, performance.now()); ui.provisionalHit(e, renderer, performance.now()); };
    shots.onRetract = key => { net.remoteHealth.retract(key); ui.retractHit(key, performance.now()); };
    shots.onConfirm = (key, e) => ui.confirmHit(key, e);
    net.onCombat = m => shots.resolve(m);
    net.weapons.onCorrection = slot => { controls.slot = slot; pendingFireAim = undefined; };
    net.onEvents = events => {
        for (const e of events) {
            const provisional = shots.reconcileEvent(e);
            if (!provisional) ui.event(e, renderer, performance.now());
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
                if (e.shooter === net.id && !provisional)
                    audio.hit(e.zone === 'head', e.lethal);
                if (e.victim === net.id) {
                    renderer.damage();
                    audio.hurt();
                }
            }
        }
    };
    function sampleInput(seq: number) {
        const timing = net.shotTiming();
        const input: Input = { ...controls.sample(seq, timing.shotTime), ...timing, combat: true, fire: false, life: net.predicted?.life };
        // A shot shown between physics ticks keeps its original aim on the next
        // command even though the camera recoil has already responded this frame.
        if (pendingFireAim?.seq === seq) Object.assign(input, pendingFireAim);
        if (!playing || ui.menu || ui.paused || !controls.locked || net.round?.phase !== 'playing') {
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
            if (firstFrame || budget.shouldRender(time)) {
                if (budget.observe(time, controls.locked && playing)) renderer.setResolutionScale(budget.scale);
                renderFrame(time);
            }
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
        const p = net.predicted, now = net.serverNow;
        const currentPhase = net.round?.phase ?? '';
        if (currentPhase !== phase) {
            phase = currentPhase;
            playing = phase === 'playing';
            ui.syncPhase(phase);
            playing = playing && !ui.home;
            ui.paused = playing && !ui.menu && !controls.locked;
            ui.scoreOpen = false;
            if (!playing) { controls.unlock(); pendingFireAim = undefined; }
            ui.visibility();
        }
        if (ui.home) {
            renderer.renderHome(reducedMotion?.matches ? 0 : time / 1000, homeStage.getBoundingClientRect());
            document.getElementById('character-loading')!.classList.add('hidden');
            return;
        }
        if (p && p.life !== lastLife) {
            lastLife = p.life;
            shots.clear();
            pendingFireAim = undefined;
            controls.yaw = p.yaw;
            controls.pitch = p.pitch;
            controls.slot = p.weapon === CLASSES[p.classId].weapon ? 1 : p.weapon === 'pistol' ? 2 : 3;
            spawnReadyAt = time + 250;
            audio.spawn();
        }
        const remotes = net.remotePlayers();
        shots.expire(time);
        if (time - lastCombatLog >= 30000) { lastCombatLog = time; console.info('Combat prediction session', shots.metrics); }
        if (!p?.alive) { pendingFireAim = undefined; if (controls.touchMode) controls.clear(); }
        controls.updateLook(dt, playing && !ui.paused ? p : undefined, remotes, net.round?.mode ?? 'ffa', now);
        motion.advance(dt, net, sampleInput, input => {
            controls.touch.consumed(input);
            if (pendingFireAim?.seq === input.seq) pendingFireAim = undefined;
        });
        if (p && playing && controls.locked && !controls.typing && !ui.menu) net.selectWeapon(controls.slot);
        if (p && renderer.viewmodel.weapon !== p.weapon) renderer.viewmodel.setWeapon(p.weapon);
        if (p && playing && controls.locked && !controls.typing && !ui.menu && p.alive && net.round?.phase === 'playing') {
            if (controls.fire && !net.changingClass && net.weapons.canFire && !pendingFireAim && time >= spawnReadyAt && p.reloadEnd <= now && (p.ammo > 0 || p.weapon === 'knife')) {
                const input = sampleInput(net.seq + 1);
                input.fire = !(input.reload && p.weapon !== 'knife' && p.ammo < WEAPONS[p.weapon].magazine);
                const clock = net.weapons.preview(p, input);
                const index = clock.fire();
                if (input.fire && index !== undefined) {
                    // Use the exact committed command/eye and shared combat state.
                    // Freeze it until the next physics step so recoil and movement
                    // sampled on another frame cannot alter the predicted ray.
                    const shotPlayer = { ...p, bloom: clock.bloom };
                    predictInput(shotPlayer, input, true);
                    const recoil = shots.fire(shotPlayer, input, index, clock.aim, renderer.shotMuzzle(shotPlayer, input, net.correction), remotes, net.round.mode, now);
                    if (recoil) {
                        pendingFireAim = input;
                        net.weapons.predictShot(p, input);
                        controls.pitch = clamp(controls.pitch + recoil[0], -1.54, 1.54);
                        controls.yaw += recoil[1];
                    }
                }
            }
            if (p.grounded && Math.hypot(p.vx, p.vz) > 3 && time - lastStep > 280 && p.slide <= 0) {
                lastStep = time;
                audio.step();
            }
        }
        controls.touch.finishFrame();
        controls.drawTouch();
        net.smoothCorrection(dt);
        const rendered = motion.preview(net.predicted, sampleInput(net.seq + 1), playing);
        const aim = controls.locked && controls.aim && !!p?.alive && p.reloadEnd <= now;
        if (p?.reloadEnd && p.reloadEnd !== previousReload) audio.reload();
        previousReload = p?.reloadEnd ?? 0;
        renderer.render(dt, time / 1000, rendered, remotes, controls, net.correction, ui.menu, aim, now, net.round?.mode ?? 'ffa');
        ui.update(time, renderer, aim, remotes);
    }
    requestAnimationFrame(frame);
    // Read-only diagnostics for external browser verification; no server debug commands are exposed.
    Object.defineProperty(window, '__arena', { value: { get metrics() { const errors = [...net.correctionDistances].sort((a, b) => a - b); return { remote: net.interpolation.metrics, combat: shots.metrics, combatReceiptMs: [...net.combatDelays], movement: net.movementMetrics, fps: renderer.fps, targetHz: budget.targetHz, pixelRatio: renderer.gl.getPixelRatio(), touch: controls.touchMode, ping: net.ping, drawCalls: renderer.drawCalls, triangles: renderer.triangles, pendingInputs: net.pending.length, predictionInputs: net.predictionHistory.pending.length, reconciliations: net.reconciliations, correctionP50: errors[Math.floor((errors.length - 1) * .5)] ?? 0, correctionP95: errors[Math.floor((errors.length - 1) * .95)] ?? 0, maxCorrection: net.maxCorrection, maxFrameCorrection: net.maxFrameCorrection, interpolationDelay: net.interpolationDelay, receivedBytes: net.bytes, connection: net.status, lobby: ui.lobby.metrics }; }, get state() { return { id: net.id, room: net.room, local: net.local, predicted: net.predicted, round: net.round, players: [...net.players.values()] }; } } });

    return started;
}
