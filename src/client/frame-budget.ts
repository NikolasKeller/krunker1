// Sustained slow frames reduce resolution first, then settle at 30 Hz. The
// fallback is latched until settings change, avoiding 30/60 oscillation.
export class FrameBudget {
    targetHz = 60;
    scale = 1;
    private window: number[] = [];
    private last = 0;
    private observed = 0;
    constructor(public mobile: boolean) {}
    reset() { this.targetHz = 60; this.scale = 1; this.window = []; this.last = this.observed = 0; }
    shouldRender(time: number) {
        if (!this.mobile) return true;
        const interval = 1000 / this.targetHz;
        if (time - this.last < interval - .8) return false;
        this.last += Math.max(1, Math.floor((time - this.last + .8) / interval)) * interval;
        return true;
    }
    observe(time: number, active: boolean) {
        const elapsed = time - this.observed; this.observed = time;
        if (!this.mobile || !active || this.targetHz === 30 || elapsed <= 0 || elapsed > 100) { this.window = []; return false; }
        this.window.push(elapsed);
        if (this.window.length < 120) return false;
        const slow = this.window.filter(ms => ms > 20).length / this.window.length;
        this.window = [];
        if (slow < .25) return false;
        if (this.scale > .71) this.scale = Math.max(.7, this.scale - .15);
        else { this.targetHz = 30; this.last = time; }
        return true;
    }
}
