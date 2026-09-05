export function privateHost(host: string) {
    return host === 'localhost' || host === '[::1]' || host.endsWith('.local') || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^\[f[cd][0-9a-f:]+\]$/i.test(host);
}

export function httpOrigin(value: string | null | undefined) {
    try {
        const url = new URL(value!);
        return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.origin : undefined;
    } catch { return undefined; }
}

export function inviteAddresses(href: string, room: string, info: { publicUrl?: string | null; lan?: string[] } = {}, dev = false) {
    const current = new URL(href);
    const link = (origin: string) => { const url = new URL(origin); url.searchParams.set('room', room); return url.href; };
    // The origin the browser reached is authoritative on public deployments, even with an old server.
    if (!privateHost(current.hostname)) return { invite: link(current.origin), lan: [] };
    const publicOrigin = httpOrigin(info.publicUrl);
    if (publicOrigin && !privateHost(new URL(publicOrigin).hostname)) return { invite: link(publicOrigin), lan: [] };
    const lan = (info.lan ?? []).flatMap(value => {
        const origin = httpOrigin(value);
        if (!origin || !privateHost(new URL(origin).hostname)) return [];
        const url = new URL(origin);
        if (dev) url.port = current.port;
        return [link(url.origin)];
    });
    const loopback = current.hostname === 'localhost' || current.hostname === '[::1]' || /^127\./.test(current.hostname);
    return { invite: loopback && lan.length ? lan[0] : link(current.origin), lan };
}
