import * as THREE from 'three';
import { abilityActive, GRENADE } from '../shared/abilities';
import { stepGrenade, type GrenadeBody } from '../shared/grenade';
import { CLASSES } from '../shared/weapons';
import { distance } from '../shared/math';
import type { GameEvent, PlayerState } from '../shared/types';

export class TacticalEffects {
    private grenades = new Map<string, GrenadeBody & { mesh: THREE.Mesh; until: number; at: number }>();
    private rings = new Map<string, THREE.Mesh>();
    private blasts: { mesh: THREE.Mesh; until: number }[] = [];
    private grenadeGeo = new THREE.IcosahedronGeometry(.16, 0);
    private ringGeo = new THREE.TorusGeometry(.55, .035, 4, 24);
    private blastGeo = new THREE.SphereGeometry(1, 12, 8);
    constructor(private scene: THREE.Scene) {}
    event(e: GameEvent, now: number) {
        if (e.type !== 'grenade') return false;
        let g = this.grenades.get(e.id);
        if (e.phase === 'cancel') {
            if (g) { this.release(g.mesh); this.grenades.delete(e.id); }
            return false;
        }
        if (e.phase === 'blast') {
            if (g) { this.release(g.mesh); this.grenades.delete(e.id); }
            const mesh = new THREE.Mesh(this.blastGeo, new THREE.MeshBasicMaterial({ color: 0xffb461, transparent: true, opacity: .2, depthWrite: false }));
            mesh.position.copy(e.position); this.scene.add(mesh); this.blasts.push({ mesh, until: now + 300 });
            return true;
        }
        const fresh = !g;
        if (!g) {
            const mesh = new THREE.Mesh(this.grenadeGeo, new THREE.MeshBasicMaterial({ color: 0xff6c4b }));
            this.scene.add(mesh); g = { mesh, position: { ...e.position }, velocity: { ...e.velocity }, until: e.until, at: e.time }; this.grenades.set(e.id, g);
        }
        g.position = { ...e.position }; g.velocity = { ...e.velocity }; g.at = e.time;
        return fresh;
    }
    update(now: number, players: PlayerState[], local?: PlayerState) {
        let warning = '';
        for (const [id, g] of this.grenades) {
            if (now > g.until + 500) { this.release(g.mesh); this.grenades.delete(id); continue; }
            // Interpolate the actual bouncing trajectory between server samples.
            const end = Math.min(now, g.until);
            while (g.at < end - 1e-6) { const dt = Math.min(1 / 60, (end - g.at) / 1000); stepGrenade(g, dt); g.at += dt * 1000; }
            g.mesh.position.copy(g.position); g.mesh.rotation.x = now / 180;
            g.mesh.scale.setScalar(1 + .35 * Math.sin(now / 65));
            if (local?.alive && distance(local, g.position) < GRENADE.radius + 3) warning = `GRENADE · ${Math.max(0, (g.until - now) / 1000).toFixed(1)}s · MOVE`;
        }
        const warningNode = document.getElementById('grenade-warning');
        if (warningNode) { warningNode.textContent = warning; warningNode.classList.toggle('hidden', !warning); }
        const active = new Set<string>();
        for (const p of players) if (p.alive && abilityActive(p, now)) {
            active.add(p.id);
            let ring = this.rings.get(p.id);
            if (!ring) { ring = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ color: CLASSES[p.classId].color })); this.scene.add(ring); this.rings.set(p.id, ring); }
            (ring.material as THREE.MeshBasicMaterial).color.set(CLASSES[p.classId].color);
            ring.position.set(p.x, p.y + .12, p.z); ring.rotation.x = Math.PI / 2;
            ring.scale.setScalar(p.classId === 'vince' ? 1.4 : 1);
        }
        for (const [id, ring] of this.rings) if (!active.has(id)) { this.release(ring); this.rings.delete(id); }
        for (let n = this.blasts.length - 1; n >= 0; n--) {
            const b = this.blasts[n], progress = 1 - (b.until - now) / 300;
            if (progress >= 1) { this.release(b.mesh); this.blasts.splice(n, 1); }
            else { b.mesh.scale.setScalar(.3 + GRENADE.radius * progress); (b.mesh.material as THREE.MeshBasicMaterial).opacity = .2 * (1 - progress); }
        }
    }
    clear() {
        for (const g of this.grenades.values()) this.release(g.mesh);
        for (const ring of this.rings.values()) this.release(ring);
        for (const b of this.blasts) this.release(b.mesh);
        this.grenades.clear(); this.rings.clear(); this.blasts = [];
        const warning = document.getElementById('grenade-warning'); if (warning) warning.classList.add('hidden');
    }
    private release(mesh: THREE.Mesh) { this.scene.remove(mesh); (mesh.material as THREE.Material).dispose(); }
}
