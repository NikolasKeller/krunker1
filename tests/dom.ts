import { JSDOM } from 'jsdom';

// A Node DOM implementation only: no browser process, renderer, or CDP connection.
export function installDOM(url = 'http://localhost:8080') {
    const dom = new JSDOM('<div id="ui"></div>', { url });
    const values = { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, location: dom.window.location, history: dom.window.history, sessionStorage: dom.window.sessionStorage };
    const saved = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
    return { dom, restore() {
        dom.window.close();
        for (const [key, descriptor] of saved) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
    } };
}
