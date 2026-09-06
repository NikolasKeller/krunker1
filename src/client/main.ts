// No static dependencies or CSS: the HTML screen can paint before any downloads.
void import('./lobby-app').then(app => app.startLobby()).catch(error => window.__furoStartup.fail(error));
