import { clamp } from '../shared/math';
import type { Input, Mode, PlayerState } from '../shared/types';
import { assistedLook } from './aim-assist';
import { TouchInput, touchDevice, TOUCH_SENSITIVITY, type TouchRole } from './touch';
export class Controls {
    keys = new Set<string>();
    private actions = new Set<'ability' | 'grenade'>();
    yaw = 0;
    pitch = 0;
    private mouseFire = false;
    private mouseAim = false;
    readonly touch = new TouchInput();
    touchMode = touchDevice();
    slot: 1 | 2 | 3 = 1;
    // Active gameplay input. Touch sessions do not capture the pointer.
    locked = false;
    sensitivity = Number(localStorage.getItem('arena-sensitivity') ?? .0022);
    touchSensitivity = Number(localStorage.getItem('arena-touch-sensitivity') ?? TOUCH_SENSITIVITY);
    onLock: (locked: boolean) => void = () => {};
    onMode: (touch: boolean) => void = () => {};
    onScore: (open: boolean) => void = () => {};
    onPause: () => void = () => {};
    get fire() { return this.mouseFire || this.touch.held('fire'); }
    set fire(value: boolean) { this.mouseFire = value; }
    get aim() { return this.mouseAim || this.touch.aim; }
    set aim(value: boolean) { this.mouseAim = value; }
    get typing() { return !!document.activeElement?.matches('input,textarea,select,[contenteditable]'); }
    constructor(private canvas: HTMLCanvasElement) {
        document.documentElement.classList.toggle('touch-device', this.touchMode);
        document.addEventListener('pointerlockchange', () => {
            if (this.touchMode) return;
            this.locked = document.pointerLockElement === canvas;
            if (!this.locked) this.clear(); this.onLock(this.locked);
        });
        document.addEventListener('pointerlockerror', () => { if (!this.touchMode) this.onLock(false); });
        addEventListener('mousemove', e => {
            if (!this.locked || this.touchMode || this.typing) return;
            this.yaw -= e.movementX * this.sensitivity * (this.aim ? .62 : 1);
            this.pitch = clamp(this.pitch - e.movementY * this.sensitivity * (this.aim ? .62 : 1), -1.54, 1.54);
        });
        addEventListener('keydown', e => {
            if ((e.target as HTMLElement).closest('input,select,textarea,button,a,[contenteditable]')) return;
            if (['Tab', 'Space', 'ShiftLeft', 'ShiftRight'].includes(e.code)) e.preventDefault();
            if (e.code === 'Tab') this.onScore(true);
            if (e.code === 'Escape') { this.unlock(); this.onPause(); }
            if (!this.locked) return;
            this.keys.add(e.code);
            if (!e.repeat && e.code === 'KeyQ') this.actions.add('ability');
            if (!e.repeat && e.code === 'KeyG') this.actions.add('grenade');
            if (e.code === 'Digit1') this.slot = 1;
            if (e.code === 'Digit2') this.slot = 2;
            if (e.code === 'Digit3') this.slot = 3;
        });
        addEventListener('keyup', e => { this.keys.delete(e.code); if (e.code === 'Tab') { e.preventDefault(); this.onScore(false); } });
        addEventListener('mousedown', e => { if (!this.locked || this.touchMode || this.typing) return; if (e.button === 0) this.fire = true; if (e.button === 2) this.aim = true; });
        addEventListener('mouseup', e => { if (e.button === 0) this.fire = false; if (e.button === 2) this.aim = false; });
        document.addEventListener('pointerdown', e => {
            if (e.pointerType === 'touch' || e.pointerType === 'pen') this.setTouchMode(true);
            else if (e.pointerType === 'mouse') this.setTouchMode(false);
        }, true);
        const root = document.getElementById('touch-controls');
        root?.addEventListener('pointerdown', e => {
            if (!this.locked || !this.touchMode || this.typing || e.pointerType === 'mouse') return;
            const target = (e.target as HTMLElement).closest<HTMLElement>('[data-touch],[data-touch-command],[data-touch-slot]');
            if (!target) return;
            e.preventDefault();
            const role = target.dataset.touch as TouchRole | undefined;
            if (role && this.touch.begin(e.pointerId, role, e.clientX, e.clientY)) root.setPointerCapture?.(e.pointerId);
            if (target.dataset.touchSlot) this.slot = Number(target.dataset.touchSlot) as Input['slot'];
            if (target.dataset.touchCommand === 'aim') this.touch.aim = !this.touch.aim;
            if (target.dataset.touchCommand === 'pause') { this.unlock(); this.onPause(); }
            if (target.dataset.touchCommand === 'score') { this.clear(); this.onScore(true); }
            this.drawTouch();
        });
        root?.addEventListener('pointermove', e => {
            if (!this.touch.pointers.has(e.pointerId)) return;
            e.preventDefault(); this.touch.move(e.pointerId, e.clientX, e.clientY); this.drawTouch();
        });
        for (const kind of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) root?.addEventListener(kind, e => {
            this.touch.end(e.pointerId, kind !== 'pointerup'); this.drawTouch();
        });
        canvas.addEventListener('contextmenu', e => e.preventDefault());
        root?.addEventListener('contextmenu', e => e.preventDefault());
        // Safari still emits gesture events on versions that ignore touch-action.
        for (const name of ['touchstart', 'touchmove', 'gesturestart', 'gesturechange']) document.addEventListener(name, e => {
            if (this.locked && this.touchMode && !(e.target as HTMLElement).closest?.('.modal-layer,.menu')) e.preventDefault();
        }, { passive: false });
        addEventListener('blur', () => { if (this.touchMode) this.unlock(); else this.clear(); });
        addEventListener('resize', () => { if (this.touchMode && window.innerHeight > window.innerWidth) this.unlock(); });
        document.addEventListener('focusin', () => { if (this.typing) this.clear(); });
        document.addEventListener('visibilitychange', () => { if (document.hidden) { if (this.touchMode) this.unlock(); else this.clear(); } });
    }
    setTouchMode(touch: boolean) {
        if (touch === this.touchMode) return;
        const wasActive = this.locked;
        this.clear(); this.touchMode = touch;
        document.documentElement.classList.toggle('touch-device', touch);
        if (touch) document.exitPointerLock?.();
        else if (wasActive) this.unlock();
        this.onMode(touch);
    }
    lock() {
        (document.activeElement as HTMLElement)?.blur();
        this.clear();
        if (this.touchMode) { this.locked = window.innerWidth >= window.innerHeight; this.onLock(this.locked); return; }
        try {
            const result = this.canvas.requestPointerLock();
            if (result && typeof result.catch === 'function') result.catch(() => this.onLock(false));
        } catch { this.onLock(false); }
    }
    unlock() { this.locked = false; this.clear(); document.exitPointerLock?.(); this.onLock(false); }
    clear() { this.actions.clear(); this.keys.clear(); this.fire = false; this.aim = false; this.touch.clear(); this.drawTouch(); this.onScore(false); }
    updateLook(dt: number, player?: PlayerState, remotes: PlayerState[] = [], mode: Mode = 'ffa', now = 0) {
        const delta = this.touch.consumeLook();
        if (!this.touchMode || !this.locked || this.typing) return;
        const scale = this.touchSensitivity * (this.aim ? .62 : 1);
        Object.assign(this, assistedLook(this.yaw, this.pitch, -delta.x * scale, -delta.y * scale, dt, player, remotes, mode, now));
    }
    drawTouch() {
        const stick = document.getElementById('touch-stick'), p = this.touch.joystick;
        stick?.classList.toggle('hidden', !p);
        if (stick && p) {
            stick.style.left = `${p.startX}px`; stick.style.top = `${p.startY}px`;
            const dx = p.x - p.startX, dy = p.y - p.startY, scale = Math.min(1, 56 / (Math.hypot(dx, dy) || 1));
            stick.firstElementChild!.setAttribute('style', `transform:translate(${dx * scale}px,${dy * scale}px)`);
        }
        document.querySelector('[data-touch-command="aim"]')?.setAttribute('aria-pressed', String(this.aim));
        document.querySelectorAll<HTMLElement>('[data-touch-slot]').forEach(b => b.classList.toggle('selected', Number(b.dataset.touchSlot) === this.slot));
    }
    consumed(input: Input) {
        for (const tool of ['ability', 'grenade'] as const) if (input[tool]) this.actions.delete(tool);
        this.touch.consumed(input);
    }
    sample(seq: number, time: number): Input {
        const active = this.locked && !this.typing;
        const down = (k: string) => active && this.keys.has(k);
        const movement = active ? this.touch.movement : { forward: 0, strafe: 0 };
        return { seq, ...(active && (this.actions.has('ability') || this.touch.pressed('ability')) ? { ability: true } : {}), ...(active && (this.actions.has('grenade') || this.touch.pressed('grenade')) ? { grenade: true } : {}), forward: clamp(Number(down('KeyW')) - Number(down('KeyS')) + movement.forward, -1, 1), strafe: clamp(Number(down('KeyD')) - Number(down('KeyA')) + movement.strafe, -1, 1), yaw: this.yaw, pitch: this.pitch, jump: down('Space') || (active && this.touch.held('jump')), slide: down('ShiftLeft') || down('ShiftRight') || (active && this.touch.held('slide')), fire: active && this.fire, aim: active && this.aim, reload: down('KeyR') || (active && this.touch.held('reload')), slot: this.slot, shotTime: time };
    }
}
