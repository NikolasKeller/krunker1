// Runs in its own Node process with its own DOM, storage, Network, and real WebSocket.
import { WebSocket } from 'ws';
import { installDOM } from './dom';
import { Network } from '../src/client/network';
import { UI } from '../src/client/ui';
import { LOBBY_UPDATE_MS } from '../src/client/lobby';
import type { ClientMessage } from '../src/shared/types';

installDOM(process.env.GAME_URL);
Object.defineProperty(globalThis, 'WebSocket', { value: WebSocket, configurable: true });
const net = new Network(), ui = new UI(net), sent: ClientMessage[] = [];
const send = net.send.bind(net);
net.send = message => { sent.push(message); send(message); };
ui.onRoom = () => net.connect(ui.joinConfig);
ui.onDeploy = () => { throw new Error('Lobby flow unexpectedly required gameplay initialization'); };
const button = document.getElementById('deploy')!, label = document.getElementById('deploy-label')!, input = document.getElementById('player-name')!;
setInterval(() => ui.updateLobby(), LOBBY_UPDATE_MS);
process.on('message', (message: { command: string; room?: string; name?: string }) => {
    if (message.command === 'create' || message.command === 'join') {
        (input as HTMLInputElement).value = message.name ?? 'Friend';
        (document.getElementById('room-code') as HTMLInputElement).value = message.room ?? '';
        if (message.command === 'create' && !net.ws) button.click();
        else document.getElementById(message.command === 'create' ? 'create-room' : 'join-room')!.click();
    }
    if (message.command === 'ready') label.click();
    if (message.command === 'start') document.getElementById('force-start')!.click();
    if (message.command === 'no-bots') net.send({ type: 'configure', bots: 0 });
    if (message.command === 'red') document.querySelector<HTMLButtonElement>('[data-team="red"]')!.click();
    if (message.command === 'stop') process.exit(0);
});
setInterval(() => {
    process.send?.({ id: net.id, room: net.room, host: net.host, status: net.status, round: net.round,
        players: [...net.players.values()], readySent: sent.filter(m => m.type === 'ready'), startSent: sent.filter(m => m.type === 'start').length,
        label: label.textContent, statusText: document.getElementById('lobby-status')!.textContent,
        stable: document.getElementById('deploy') === button && document.getElementById('deploy-label') === label && document.getElementById('player-name') === input,
        metrics: ui.lobby.metrics });
}, 25);
