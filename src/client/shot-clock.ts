import { SWITCH_MS } from '../shared/combat';
// Local weapon feedback uses the monotonic render clock. The server clock can
// move backwards when a delayed/asymmetric ping changes the offset estimate.
export class ShotClock {
    private next = 0;
    private last = -Infinity;
    private index = 0;
    reset(time: number, delay = 0) { this.next = time + delay; this.last = -Infinity; this.index = 0; }
    switchWeapon(time: number) { this.next = Math.max(this.next, time + SWITCH_MS); this.index = 0; }
    fire(time: number, interval: number) {
        if (time < this.next) return undefined;
        this.next = time + interval;
        if (time - this.last > 450) this.index = 0;
        this.last = time;
        return this.index++;
    }
}
