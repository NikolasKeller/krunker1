export type Screen = 'home' | 'lobby' | 'match';
export interface Route { screen: Screen; room: string }
export const roomCode = (value: string) => value.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 18);

// Room URLs remain the public contract. Match state belongs to this browser's history.
export class Navigation {
    route: Route;
    onBack: (route: Route) => void = () => {};
    constructor() {
        const room = roomCode(new URL(location.href).searchParams.get('room') ?? '');
        const restoringRoom = room && history.state?.furo?.room === room;
        this.route = restoringRoom ? { screen: 'lobby', room } : { screen: 'home', room: '' };
        this.write(this.route, true);
        // Give a direct invite a useful in-app Back destination without painting home.
        if (room) this.go('lobby', room);
        window.addEventListener('popstate', () => {
            const room = roomCode(new URL(location.href).searchParams.get('room') ?? '');
            this.route = { screen: room ? history.state?.furo?.screen === 'match' ? 'match' : 'lobby' : 'home', room };
            this.onBack(this.route);
        });
    }
    go(screen: Screen, room = this.route.room, replace = false) {
        if (screen === 'home') room = '';
        if (this.route.screen === screen && this.route.room === room) return;
        this.route = { screen, room };
        this.write(this.route, replace);
    }
    private write(route: Route, replace: boolean) {
        const url = new URL(location.href);
        if (route.room) url.searchParams.set('room', route.room);
        else url.searchParams.delete('room');
        history[replace ? 'replaceState' : 'pushState']({ furo: route }, '', url);
    }
}
