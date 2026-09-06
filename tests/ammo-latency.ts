// Deterministic render-loop/DOM timing, with authority held back by simulated RTT.
// This is not a browser paint or GPU measurement.
import { mkdir, writeFile } from 'node:fs/promises';
import { Room } from '../src/server/simulation';
import { WeaponPrediction } from '../src/client/weapon-prediction';
import { LocalMotion } from '../src/client/local-motion';
import { UI } from '../src/client/ui';
import { neutralInput } from '../src/shared/movement';
import type { Input } from '../src/shared/types';
import type { Network } from '../src/client/network';
import type { Renderer } from '../src/client/renderer';
import { installDOM } from './dom';
const baseline = process.argv.includes('--baseline');
const rows = [];
for (const rtt of [0, 350]) for (const hz of [60, 120, 144, 240]) {
    let maximum = 0;
    for (let phase = 0; phase < 12; phase++) {
        const env = installDOM();
        try {
            const room = new Room('AMMO'), a = room.add('You', 'triggerman', 'blue'); room.start(0);
            const weapons = new WeaponPrediction(), p = { ...a.state }, motion = new LocalMotion();
            let pending: Input | undefined, fired = false;
            const driver = { seq: 0, predicted: p, input(i: Input) { weapons.advance(p, i); } };
            const net = { predicted: p, local: a.state, players: new Map([[p.id, p]]), round: room.round, status: 'CONNECTED', serverNow: 1000, remotePlayers: () => [], send() {} } as unknown as Network;
            const ui = new UI(net), renderer = { fps: hz, viewmodel: { aim: 0 }, project: () => ({ visible: false }) } as unknown as Renderer;
            const sample = (seq: number) => pending?.seq === seq ? pending : { ...neutralInput(seq), combat: true, life: p.life, shotTime: 1000 };
            const frameMs = 1000 / hz, press = frameMs * (1 + phase / 12) + .001;
            ui.update(0, renderer, false, []);
            for (let frame = 1; frame < 20; frame++) {
                const time = frame * frameMs;
                motion.advance(1 / hz, driver, sample, i => { if (pending?.seq === i.seq) pending = undefined; });
                if (time >= press && !fired) {
                    fired = true; pending = { ...sample(driver.seq + 1), fire: true };
                    if (!baseline) weapons.predictShot(p, pending);
                }
                // A pre-input snapshot at either RTT must not undo an unacknowledged shot.
                if (time >= press + rtt) weapons.reconcile({ ...a.state, ack: 0 }, p);
                ui.update(time, renderer, false, []);
                if (document.getElementById('ammo')!.textContent === '29') { maximum = Math.max(maximum, time - press); break; }
                if (frame === 19) throw new Error('Ammo never updated');
            }
        } finally { env.restore(); }
    }
    rows.push({ rttMs: rtt, renderHz: hz, maxInputToDOMMs: +maximum.toFixed(3), frameMs: +(1000 / hz).toFixed(3), withinOneFrame: maximum <= 1000 / hz + .001 });
}
await mkdir('artifacts/mobile', { recursive: true });
await writeFile(`artifacts/mobile/ammo-${baseline ? 'before' : 'after'}.json`, JSON.stringify(rows, null, 2) + '\n');
console.log(JSON.stringify(rows, null, 2));
if (!baseline && rows.some(row => !row.withinOneFrame)) throw new Error('Ammo exceeds one rendered frame');
