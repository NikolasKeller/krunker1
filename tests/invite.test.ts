import assert from 'node:assert/strict';
import test from 'node:test';
import type { NetworkInterfaceInfo } from 'node:os';
import { connectionInfo } from '../src/server/connection';
import { inviteAddresses } from '../src/shared/invite';
import { installDOM } from './dom';
import { UI } from '../src/client/ui';
import type { Network } from '../src/client/network';

const interfaces = { en0: [{ address: '192.168.1.4', family: 'IPv4', internal: false } as NetworkInterfaceInfo], eth0: [{ address: '10.206.119.28', family: 'IPv4', internal: false } as NetworkInterfaceInfo] };
const publicOrigin = 'https://krunker1-production.up.railway.app';

test('public and proxy hosts never advertise container interfaces', () => {
    for (const headers of [{ host: 'krunker1-production.up.railway.app', 'x-forwarded-proto': 'https' }, { host: '10.206.119.28:8080', 'x-forwarded-host': 'krunker1-production.up.railway.app', 'x-forwarded-proto': 'https' }]) {
        assert.deepEqual(connectionInfo(headers, 8080, {}, interfaces, false), { publicUrl: publicOrigin, lan: [] });
    }
    assert.deepEqual(connectionInfo({ host: 'localhost:8080' }, 8080, { RAILWAY_PUBLIC_DOMAIN: 'krunker1-production.up.railway.app' }, interfaces, false), { publicUrl: publicOrigin, lan: [] });
    assert.deepEqual(connectionInfo({ host: 'localhost:8080' }, 8080, {}, interfaces, true).lan, []);
    assert.deepEqual(connectionInfo({ host: 'localhost:8080' }, 8080, { RAILWAY_PROJECT_ID: 'test' }, interfaces, false).lan, []);
});

test('local physical interfaces supply a shareable LAN invite, with the Vite port in development', () => {
    const info = connectionInfo({ host: 'localhost:3000' }, 3000, {}, { en0: interfaces.en0, docker0: interfaces.eth0 }, false);
    assert.deepEqual(info.lan, ['http://192.168.1.4:3000']);
    assert.equal(inviteAddresses('http://localhost:5173', 'ABCDE', info, true).invite, 'http://192.168.1.4:5173/?room=ABCDE');
});

test('public lobby display and copy use the working browser origin even if an old server advertises LAN', async () => {
    const env = installDOM(publicOrigin), originalFetch = globalThis.fetch;
    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    let copied = '';
    try {
        globalThis.fetch = async () => ({ json: async () => ({ lan: ['http://10.206.119.28:8080'] }) }) as Response;
        Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async (text: string) => { copied = text; } } } });
        Object.defineProperty(window, 'isSecureContext', { value: true });
        const ui = new UI({ room: 'AFZFW', send() {} } as unknown as Network);
        await ui.welcomed();
        assert.equal((document.getElementById('share-url') as HTMLInputElement).value, publicOrigin + '/?room=AFZFW');
        assert.equal(document.getElementById('lan-links')!.textContent, '');
        await ui.copyLink();
        assert.equal(copied, publicOrigin + '/?room=AFZFW');
    } finally {
        globalThis.fetch = originalFetch;
        if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
        else Reflect.deleteProperty(globalThis, 'navigator');
        env.restore();
    }
});
