import './style.css';
import { Network } from './network';
import { UI } from './ui';
import { LOBBY_UPDATE_MS } from './lobby';

export async function startLobby() {
    const startup = window.__furoStartup;
    if (startup.failed) return;
    const net = new Network();
    let timer: ReturnType<typeof setInterval> | undefined;
    try {
        const ui = new UI(net);
        ui.gameReady = false;
        ui.onRoom = () => net.connect(ui.joinConfig);
        ui.onSettings = (key, value) => localStorage.setItem(`arena-${key}`, value);
        net.onNotice = text => ui.notice(text);
        net.onChat = message => ui.chat(message);
        net.onWelcome = () => { void ui.welcomed(); };
        if (ui.joinConfig.room) net.connect(ui.joinConfig);
        ui.updateLobby();
        timer = setInterval(() => ui.updateLobby(), LOBBY_UPDATE_MS);
        // Paint the usable lobby before downloading/evaluating the renderer.
        await new Promise<void>(resolve => requestAnimationFrame(() => {
            startup.lobbyReady();
            requestAnimationFrame(() => resolve());
        }));
        const game = await import('./game');
        if (startup.failed) { clearInterval(timer); net.disconnect(); return; }
        await game.startGame(net, ui, document.getElementById('game') as HTMLCanvasElement);
        ui.gameReady = true;
        ui.updateLobby();
        startup.gameReady();
    } catch (error) {
        clearInterval(timer);
        net.disconnect();
        startup.fail(error);
    }
}
