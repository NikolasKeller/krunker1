import { UI } from '../src/client/ui';
import type { Network } from '../src/client/network';
import type { Renderer } from '../src/client/renderer';
import { CLASS_IDS } from '../src/shared/weapons';
import { Room } from './sandyard-room';
import { installDOM } from './dom';

export const layoutStates = ['class-selection', 'lobby', 'lobby-full', 'hud', 'scoreboard'] as const;
export type LayoutState = typeof layoutStates[number];
export const layoutViewports = [
    { width: 1440, height: 900, touch: false }, { width: 1280, height: 800, touch: false },
    { width: 844, height: 390, touch: true }, { width: 667, height: 375, touch: true },
];

export function createTextLayoutFixture(state: LayoutState, touch = false) {
    const home = state === 'class-selection';
    const env = installDOM(`https://furo.example/${home ? '' : '?room=FRND5'}`);
    try {
        localStorage.setItem('arena-name', 'LongCallsign1234');
        const room = new Room('FRND5');
        const names = ['LongCallsign1234', 'gypqj_Alex', 'TriggermanFan', 'Jules', 'Robin', 'Sam'];
        const players = home ? [] : Array.from({ length: state === 'lobby-full' || state === 'scoreboard' ? 17 : 6 }, (_, i) => {
            const p = room.add(names[i % names.length], CLASS_IDS[i % CLASS_IDS.length], i % 2 ? 'red' : 'blue', i >= 10).state;
            p.ready = i % 3 === 0; p.kills = 17 - i; p.deaths = i; p.score = p.kills * 100;
            return p;
        });
        const local = players[0];
        room.round.mode = 'tdm';
        room.round.phase = state === 'hud' || state === 'scoreboard' ? 'playing' : 'lobby';
        room.round.endsAt = 139000;
        const net = { id: local?.id ?? '', host: local?.id ?? '', room: home ? '' : room.id, ws: home ? undefined : {},
            status: home ? 'CREATE OR JOIN A LOBBY' : 'CONNECTED', round: home ? undefined : room.round,
            players: new Map(players.map(p => [p.id, p])), local, predicted: local, serverNow: 1000,
            ping: 15, difficulty: 'normal', bots: 0, remotePlayers: () => [], send() {} } as unknown as Network;
        const ui = new UI(net);
        ui.setTouchMode(touch); ui.choose('runngun', false); ui.updateLobby();
        document.getElementById('character-loading')!.classList.add('hidden');
        if (state === 'hud' || state === 'scoreboard') {
            ui.showMatch(); ui.paused = false; ui.scoreOpen = state === 'scoreboard'; ui.visibility();
            ui.update(100, { fps: 144, viewmodel: { aim: 0 }, project: () => ({ x: 0, y: 0, visible: false }) } as unknown as Renderer, false);
        }
        if (!home) {
            document.getElementById('lobby-sharing')!.classList.remove('hidden');
            document.getElementById('share-code')!.textContent = room.id;
            (document.getElementById('share-url') as HTMLInputElement).value = `https://furo.example/?room=${room.id}`;
        }
        for (const field of document.querySelectorAll('input')) field.setAttribute('value', field.value);
        for (const field of document.querySelectorAll('select')) for (const option of field.options) option.toggleAttribute('selected', option.selected);
        return { ...env, ui };
    } catch (error) { env.restore(); throw error; }
}
