import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import type { IncomingHttpHeaders } from 'node:http';
import { httpOrigin, privateHost } from '../shared/invite';

export function connectionInfo(headers: IncomingHttpHeaders, port: number, env = process.env, interfaces = networkInterfaces(), container = existsSync('/.dockerenv') || existsSync('/run/.containerenv')) {
    const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)?.split(',')[0].trim();
    const host = first(headers['x-forwarded-host']) || headers.host;
    const protocol = first(headers['x-forwarded-proto']) === 'https' ? 'https' : 'http';
    const requestOrigin = httpOrigin(`${protocol}://${host}`);
    const configured = httpOrigin(env.PUBLIC_URL || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : undefined));
    const publicUrl = [configured, requestOrigin].find(origin => origin && !privateHost(new URL(origin).hostname)) ?? null;
    // Cloud/container interfaces aren't LAN invitations. Only physical host interfaces are eligible.
    const hosted = container || !!(env.RAILWAY_ENVIRONMENT_ID || env.RAILWAY_PROJECT_ID || env.KUBERNETES_SERVICE_HOST);
    const lan = publicUrl || hosted ? [] : Object.entries(interfaces).flatMap(([name, addresses]) =>
        /^(en\d|en[opsx]|eth\d|wl|Wi-Fi|Ethernet)/i.test(name) ? (addresses ?? []).filter(i => !i.internal && i.family === 'IPv4' && privateHost(i.address)).map(i => `http://${i.address}:${port}`) : []);
    return { publicUrl, lan };
}
