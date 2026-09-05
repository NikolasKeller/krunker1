import { clamp } from '../shared/math';
import type { Input } from '../shared/types';
export class Controls {
    keys = new Set<string>();
    yaw = 0;
    pitch = 0;
    fire = false;
    aim = false;
    slot: 1 | 2 | 3 = 1;
    locked = false;
    sensitivity = Number(localStorage.getItem('arena-sensitivity') ?? 0.0022);
    onLock: (locked: boolean) => void = () => { };
    onScore: (open: boolean) => void = () => { };
    onPause: () => void = () => { };
    onChat: () => void = () => { };
    get typing() { return !!document.activeElement?.matches('input,textarea,[contenteditable]'); }
    constructor(private canvas: HTMLCanvasElement) {
        document.addEventListener('pointerlockchange', () => { this.locked = document.pointerLockElement === canvas; if (!this.locked)
            this.clear(); this.onLock(this.locked); });
        document.addEventListener('pointerlockerror', () => this.onLock(false));
        addEventListener('mousemove', e => { if (!this.locked || this.typing)
            return; this.yaw -= e.movementX * this.sensitivity * (this.aim ? 0.62 : 1); this.pitch = clamp(this.pitch - e.movementY * this.sensitivity * (this.aim ? 0.62 : 1), -1.54, 1.54); });
        addEventListener('keydown', e => { if ((e.target as HTMLElement).closest('input,select,textarea,button,a,[contenteditable]'))
            return; if (e.code === 'Enter' && this.locked && !e.repeat) { e.preventDefault(); this.clear(); this.onChat(); return; } if (['Tab', 'Space', 'ShiftLeft', 'ShiftRight'].includes(e.code))
            e.preventDefault(); if (e.code === 'Tab')
            this.onScore(true); if (e.code === 'Escape')
            this.onPause(); if (!this.locked)
            return; this.keys.add(e.code); if (e.code === 'Digit1')
            this.slot = 1; if (e.code === 'Digit2')
            this.slot = 2; if (e.code === 'Digit3')
            this.slot = 3; });
        addEventListener('keyup', e => { this.keys.delete(e.code); if (e.code === 'Tab') {
            e.preventDefault();
            this.onScore(false);
        } });
        addEventListener('mousedown', e => { if (!this.locked || this.typing)
            return; if (e.button === 0)
            this.fire = true; if (e.button === 2)
            this.aim = true; });
        addEventListener('mouseup', e => { if (e.button === 0)
            this.fire = false; if (e.button === 2)
            this.aim = false; });
        canvas.addEventListener('contextmenu', e => e.preventDefault());
        addEventListener('blur', () => this.clear());
        document.addEventListener('focusin', () => { if (this.typing) this.clear(); });
        document.addEventListener('visibilitychange', () => { if (document.hidden)
            this.clear(); });
    }
    lock() { try {
        const result = this.canvas.requestPointerLock();
        if (result && typeof result.catch === 'function')
            result.catch(() => this.onLock(false));
    }
    catch {
        this.onLock(false);
    } }
    clear() { this.keys.clear(); this.fire = false; this.aim = false; this.onScore(false); }
    sample(seq: number, time: number): Input {
        const active = this.locked && !this.typing;
        const down = (k: string) => active && this.keys.has(k);
        return { seq, forward: Number(down('KeyW')) - Number(down('KeyS')), strafe: Number(down('KeyD')) - Number(down('KeyA')), yaw: this.yaw, pitch: this.pitch, jump: down('Space'), slide: down('ShiftLeft') || down('ShiftRight'), fire: active && this.fire, aim: active && this.aim, reload: down('KeyR'), slot: this.slot, shotTime: time };
    }
}
