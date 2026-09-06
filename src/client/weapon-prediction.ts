import { CombatClock } from '../shared/combat';
import { CLASSES, WEAPONS } from '../shared/weapons';
import type { Input, PlayerState, WeaponId, WeaponMessage } from '../shared/types';
export const slotWeapon = (p: PlayerState, slot: Input['slot']): WeaponId => slot === 1 ? CLASSES[p.classId].weapon : slot === 2 ? 'pistol' : 'knife';

// Presentation/inventory estimate only. Health, score and permission to fire
// remain on the server; all commands are still validated there.
export class WeaponPrediction {
    clock = new CombatClock('sniper');
    private life = -1;
    private ammo = new Map<WeaponId, number>();
    private pending?: { seq: number; weapon: WeaponId };
    private shots: { seq: number; weapon: WeaponId }[] = [];
    private active = false;
    private reload?: { seq: number; weapon: WeaponId; until: number };
    get canFire() { return !this.reload; }
    onCorrection: (slot: Input['slot']) => void = () => {};
    reset() { this.life = -1; this.pending = undefined; this.shots = []; this.ammo.clear(); this.active = false; this.reload = undefined; }
    private init(p: PlayerState) {
        if (p.life === this.life) return;
        this.reset(); this.life = p.life;
        this.clock = new CombatClock(p.weapon);
        for (const [id, w] of Object.entries(WEAPONS)) this.ammo.set(id as WeaponId, w.magazine);
        this.ammo.set(p.weapon, p.ammo);
    }
    select(p: PlayerState, slot: Input['slot'], seq: number) {
        this.init(p); this.active = true;
        const weapon = slotWeapon(p, slot);
        if (!p.alive || weapon === p.weapon) return false;
        this.ammo.set(p.weapon, p.ammo);
        this.pending = { seq, weapon }; this.reload = undefined;
        Object.assign(p, { weapon, ammo: this.ammo.get(weapon) ?? WEAPONS[weapon].magazine, reloadEnd: 0, bloom: 0, aiming: false });
        return true;
    }
    preview(p: PlayerState, input: Input) {
        this.init(p);
        const clock = this.clock.copy();
        clock.advance(slotWeapon(p, input.slot), input, Math.hypot(p.vx, p.vz));
        return clock;
    }
    private startReload(p: PlayerState, input: Input) {
        if (!p.alive || p.weapon === 'knife' || p.reloadEnd || this.reload || p.ammo >= WEAPONS[p.weapon].magazine) return;
        p.reloadEnd = input.shotTime + (input.interpolationDelay ?? 0) + WEAPONS[p.weapon].reload;
        this.reload = { seq: input.seq, weapon: p.weapon, until: p.reloadEnd };
    }
    // Called on the render frame that displays the shot, before its fixed command
    // step. advance still owns cadence; this estimate is applied only once.
    predictShot(p: PlayerState, input: Input) {
        if (!input.combat || !input.fire || !p.alive || (input.life !== undefined && input.life !== p.life)) return;
        this.init(p); this.active = true;
        if (this.shots.some(s => s.seq === input.seq) || p.weapon === 'knife') return;
        p.ammo = Math.max(0, p.ammo - 1);
        this.shots.push({ seq: input.seq, weapon: p.weapon });
        if (this.shots.length > 600) this.shots.shift();
        this.ammo.set(p.weapon, p.ammo);
        if (p.ammo === 0) this.startReload(p, input);
    }
    advance(p: PlayerState, input: Input) {
        if (!input.combat || !p.alive || (input.life !== undefined && input.life !== p.life)) return;
        this.init(p); this.active = true;
        this.select(p, input.slot, input.seq);
        this.clock.advance(p.weapon, input, Math.hypot(p.vx, p.vz));
        if (input.reload) this.startReload(p, input);
        const shown = this.shots.some(s => s.seq === input.seq);
        if (input.fire && (shown || (!this.reload && !p.reloadEnd && (p.ammo > 0 || p.weapon === 'knife'))) && this.clock.fire() !== undefined) {
            this.clock.bloomAfterFire();
            if (!shown) this.predictShot(p, input);
        }
        p.bloom = this.clock.bloom;
    }
    reconcile(authority: PlayerState, p: PlayerState) {
        this.init(authority);
        if (!authority.alive) { this.reset(); return; }
        if (!this.active) return;
        if (this.reload && authority.ack >= this.reload.seq && (authority.weapon !== this.reload.weapon || !authority.reloadEnd)) this.reload = undefined;
        this.shots = this.shots.filter(s => s.seq > authority.ack);
        this.ammo.set(authority.weapon, Math.max(0, authority.ammo - this.shots.filter(s => s.weapon === authority.weapon).length));
        if (this.pending && authority.ack >= this.pending.seq) {
            if (authority.weapon !== this.pending.weapon) this.onCorrection(authority.weapon === CLASSES[p.classId].weapon ? 1 : authority.weapon === 'pistol' ? 2 : 3);
            this.pending = undefined;
        }
        const weapon = this.pending?.weapon ?? authority.weapon;
        Object.assign(p, { weapon, ammo: this.ammo.get(weapon), bloom: this.clock.bloom });
        if (this.reload && this.reload.weapon === weapon && authority.ack < this.reload.seq) p.reloadEnd = this.reload.until;
        else p.reloadEnd = weapon !== authority.weapon ? 0 : authority.reloadEnd;
    }
    confirm(m: WeaponMessage, p: PlayerState) {
        if (m.life !== this.life) return;
        this.ammo.set(m.weapon, Math.max(0, m.ammo - this.shots.filter(s => s.seq > m.seq && s.weapon === m.weapon).length));
        if (this.pending && m.seq < this.pending.seq) return;
        if (this.pending && m.weapon !== this.pending.weapon) this.onCorrection(m.weapon === CLASSES[p.classId].weapon ? 1 : m.weapon === 'pistol' ? 2 : 3);
        this.pending = { seq: m.seq, weapon: m.weapon };
        Object.assign(p, { weapon: m.weapon, ammo: this.ammo.get(m.weapon), reloadEnd: m.reloadEnd });
        if (this.reload?.weapon === m.weapon && m.seq < this.reload.seq) p.reloadEnd = this.reload.until;
    }
}
