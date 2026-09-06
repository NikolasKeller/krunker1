export interface StartupScreen {
    readonly failed: boolean;
    fail(error: unknown): void;
    lobbyReady(): void;
    gameReady(): void;
}

declare global {
    interface Window { __furoStartup: StartupScreen; }
}
