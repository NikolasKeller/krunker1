import { clamp } from '../shared/math';

export const TOUCH_SENSITIVITY = .004;
export function touchDevice(win: Window = window) {
    return (win.navigator.maxTouchPoints ?? 0) > 0 &&
        (!!win.matchMedia?.('(pointer: coarse)').matches || typeof win.matchMedia !== 'function');
}
export function joystickVector(dx: number, dy: number, radius = 56, deadZone = .14) {
    const length = Math.hypot(dx, dy);
    const magnitude = clamp((length / radius - deadZone) / (1 - deadZone), 0, 1);
    return { strafe: length ? dx / length * magnitude : 0, forward: length ? -dy / length * magnitude : 0 };
}
export type TouchRole = 'move' | 'look' | 'fire' | 'jump' | 'slide' | 'reload' | 'ability' | 'grenade';
type Contact = { role: TouchRole; x: number; y: number; startX: number; startY: number };
// Contacts own their role until release, even when crossing another control.
export class TouchInput {
    readonly pointers = new Map<number, Contact>();
    private dx = 0;
    private dy = 0;
    private taps = new Set<TouchRole>();
    aim = false;
    get joystick() { return [...this.pointers.values()].find(p => p.role === 'move'); }
    get movement() { const p = this.joystick; return p ? joystickVector(p.x - p.startX, p.y - p.startY) : { forward: 0, strafe: 0 }; }
    pressed(role: TouchRole) { return this.taps.has(role); }
    held(role: TouchRole) { return this.taps.has(role) || [...this.pointers.values()].some(p => p.role === role); }
    begin(id: number, role: TouchRole, x: number, y: number) {
        if (this.pointers.has(id) || (role === 'move' && this.joystick) || (role === 'look' && [...this.pointers.values()].some(p => p.role === 'look'))) return false;
        this.pointers.set(id, { role, x, y, startX: x, startY: y });
        if (['fire', 'jump', 'slide', 'reload', 'ability', 'grenade'].includes(role)) this.taps.add(role);
        return true;
    }
    move(id: number, x: number, y: number) {
        const p = this.pointers.get(id); if (!p) return;
        // FIRE doubles as a look surface, allowing two-thumb move + aim + fire.
        if (p.role === 'look' || p.role === 'fire') { this.dx += x - p.x; this.dy += y - p.y; }
        p.x = x; p.y = y;
    }
    end(id: number, cancelled = false) {
        const p = this.pointers.get(id); this.pointers.delete(id);
        if (cancelled && p) { this.taps.delete(p.role); this.dx = this.dy = 0; }
    }
    consumeLook() { const delta = { x: this.dx, y: this.dy }; this.dx = this.dy = 0; return delta; }
    consumed(input?: { jump: boolean; slide: boolean; reload: boolean; ability?: boolean; grenade?: boolean }) {
        for (const role of ['jump', 'slide', 'reload', 'ability', 'grenade'] as const) if (!input || input[role]) this.taps.delete(role);
    }
    finishFrame() { this.taps.delete('fire'); }
    clear() { this.pointers.clear(); this.taps.clear(); this.dx = this.dy = 0; this.aim = false; }
}

export const touchMarkup = `
<div id="touch-controls" class="touch-controls hidden" aria-label="Touch controls">
  <div class="touch-move" data-touch="move" aria-label="Movement area"><span class="move-hint">MOVE</span></div>
  <div class="touch-look" data-touch="look" aria-label="Drag to look"></div>
  <div id="touch-stick" class="touch-stick hidden"><i></i></div>
  <div class="touch-tools"><button data-touch-command="score" aria-label="Scoreboard">SCORE</button><button data-touch-command="pause" aria-label="Pause game">Ⅱ</button></div>
  <div class="touch-weapons" aria-label="Switch weapon"><button data-touch-slot="1">PRIMARY</button><button data-touch-slot="2">PISTOL</button><button data-touch-slot="3">KNIFE</button></div>
  <button id="touch-ability" class="touch-tactical touch-ability" data-touch="ability" aria-label="Class ability"><b>ABILITY</b><small>READY</small></button>
  <button id="touch-grenade" class="touch-tactical touch-grenade" data-touch="grenade" aria-label="Throw grenade"><b>GRENADE</b><small>READY</small></button>
  <button class="touch-action touch-aim" data-touch-command="aim" aria-label="Toggle aim" aria-pressed="false">AIM</button>
  <button class="touch-action touch-jump" data-touch="jump">JUMP</button>
  <button class="touch-action touch-slide" data-touch="slide">SLIDE</button>
  <button class="touch-action touch-reload" data-touch="reload">RELOAD</button>
  <button class="touch-action touch-fire" data-touch="fire" aria-label="Hold to fire, drag to aim"><span>FIRE</span><small>DRAG TO AIM</small></button>
</div>`;
