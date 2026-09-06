import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { assertTextFits, inspectTextOverflow, layoutTargets, overflowAxes } from './text-overflow';
import { createTextLayoutFixture, layoutStates } from './text-layout-fixture';
import { CLASS_IDS, CLASSES } from '../src/shared/weapons';

const css = readFileSync(new URL('../src/client/style.css', import.meta.url), 'utf8');
function withRules(check: (rules: CSSStyleRule[]) => void) {
    const dom = new JSDOM(`<style>${css}</style>`);
    try {
        const rules: CSSStyleRule[] = [];
        const collect = (list: CSSRuleList) => { for (const rule of list) {
            if ('selectorText' in rule) rules.push(rule as CSSStyleRule);
            if ('cssRules' in rule) collect((rule as CSSGroupingRule).cssRules);
        } };
        collect(dom.window.document.styleSheets[0].cssRules);
        check(rules);
    } finally { dom.window.close(); }
}

test('class cards reserve intrinsic content height and wrapping at every CSS breakpoint', () => withRules(rules => {
    const cards = rules.filter(r => r.selectorText.split(',').some(s => /\.class-card(?:\.[\w-]+)?$/.test(s.trim())));
    for (const selector of ['.class-card', '.room-sidebar .class-card', '.touch-device .room-sidebar .class-card']) {
        assert.ok(cards.some(rule => rule.selectorText === selector), `inspect ${selector} sizing`);
    }
    for (const rule of cards) {
        for (const property of ['height', 'block-size']) {
            const value = rule.style.getPropertyValue(property);
            assert.ok(!value || value === 'auto', `${rule.cssText}: ${property} must grow with text`);
        }
        for (const property of ['max-height', 'max-block-size']) {
            const value = rule.style.getPropertyValue(property);
            assert.ok(!value || value === 'none', `${rule.cssText}: do not cap wrapped labels`);
        }
    }
    for (const rule of rules.filter(r => /\.class-card (strong|small)$/.test(r.selectorText))) {
        assert.notEqual(rule.style.getPropertyValue('white-space'), 'nowrap', rule.cssText);
    }
    for (const selector of ['.class-card strong', '.class-card small']) {
        assert.equal(rules.find(r => r.selectorText === selector)!.style.getPropertyValue('overflow-wrap'), 'anywhere');
    }
    assert.equal(rules.find(r => r.selectorText === '.home-controls > *')!.style.getPropertyValue('flex-shrink'), '0', 'scroll rather than compress home sections');
}));

test('class label line boxes include the bundled font ascent, descent and leading', () => withRules(rules => {
    const fontPath = css.match(/src:url\('(\/fonts\/[^']+)'\)/)![1];
    const font = readFileSync(new URL(`../public${fontPath}`, import.meta.url));
    const tables = new Map<string, number>();
    for (let i = 0; i < font.readUInt16BE(4); i++) {
        const offset = 12 + i * 16;
        tables.set(font.toString('ascii', offset, offset + 4), font.readUInt32BE(offset + 8));
    }
    const head = tables.get('head')!, hhea = tables.get('hhea')!;
    const em = font.readUInt16BE(head + 18);
    const metrics = (font.readInt16BE(hhea + 4) - font.readInt16BE(hhea + 6) + font.readInt16BE(hhea + 8)) / em;
    assert.ok(metrics > 0);
    for (const rule of rules.filter(r => /\.class-card (strong|small)$/.test(r.selectorText))) {
        const fontShorthand = rule.style.getPropertyValue('font');
        const height = rule.style.getPropertyValue('line-height') || fontShorthand.match(/\/\s*([\d.]+)/)?.[1];
        if (height) assert.ok(Number(height) >= metrics, `${rule.selectorText}: ${height}em is smaller than the font's ${metrics}em line box`);
    }
    for (const selector of ['.class-card strong', '.class-card small']) {
        const rule = rules.find(r => r.selectorText === selector)!;
        assert.match(rule.cssText, /line-height|\//, 'both labels must define a line-height');
    }
}));

test('home callsign and lobby map artwork cannot constrain their text to a fixed height', () => withRules(rules => {
    const profile = rules.filter(r => r.selectorText === '.home-profile input');
    for (const rule of profile) assert.ok(['', 'auto'].includes(rule.style.getPropertyValue('height')), rule.cssText);
    const map = rules.filter(r => r.selectorText === '.room-panel .map-thumb').at(-1)!;
    assert.equal(map.style.getPropertyValue('height'), 'auto');
    assert.equal(map.style.getPropertyValue('flex-shrink'), '0');
}));

test('overflow check catches sliced descenders, left/right overflow and a wrapped second line', () => {
    const box = { left: 0, right: 100, top: 0, bottom: 70 };
    assert.deepEqual(overflowAxes({ left: 8, right: 92, top: 46, bottom: 70 }, box), []);
    assert.deepEqual(overflowAxes({ left: 8, right: 92, top: 60, bottom: 78 }, box), ['y']);
    assert.deepEqual(overflowAxes({ left: -2, right: 92, top: 46, bottom: 60 }, box), ['x']);
    assert.deepEqual(overflowAxes({ left: 8, right: 115, top: 70, bottom: 88 }, box), ['x', 'y']);
    assert.deepEqual(overflowAxes({ left: 8, right: 92, top: 46, bottom: 70.25 }, box), [], 'allow subpixel rounding only');
});

test('DOM overflow assertion fails for the original fixed card height and passes when content fits', () => {
    // Synthetic rectangles exercise the detector, not browser layout. Real ranges run in preview pages.
    const dom = new JSDOM('<button class="class-card" style="overflow:hidden"><strong>TRIGGERMAN</strong><small>CLOSE QUARTERS gypqj</small></button>');
    try {
        const doc = dom.window.document, card = doc.querySelector('button')!;
        const rect = (top: number, bottom: number) => ({ left: 0, right: 100, top, bottom, width: 100, height: bottom - top }) as DOMRect;
        let cardBottom = 50;
        for (const element of [doc.body, card, ...card.children]) {
            element.getBoundingClientRect = () => element === card ? rect(0, cardBottom) : element.tagName === 'SMALL' ? rect(44, 58) : rect(0, 100);
            element.getClientRects = () => [element.getBoundingClientRect()] as unknown as DOMRectList;
        }
        dom.window.Range.prototype.getClientRects = function () {
            return [this.startContainer.parentElement!.tagName === 'SMALL' ? rect(44, 58) : rect(20, 40)] as unknown as DOMRectList;
        };
        assert.throws(() => assertTextFits(doc, '.class-card'), /CLOSE QUARTERS gypqj/);
        cardBottom = 70;
        assert.equal(assertTextFits(doc, '.class-card').failures.length, 0);
        // Use explicit axes because jsdom does not expand the overflow shorthand in computed styles.
        doc.body.style.overflowY = 'hidden'; doc.body.style.overflowX = 'hidden';
        let viewportHeight = 100;
        Object.defineProperty(doc.documentElement, 'clientWidth', { value: 100 });
        Object.defineProperty(doc.documentElement, 'clientHeight', { get: () => viewportHeight });
        doc.body.getBoundingClientRect = () => rect(0, 0);
        assert.equal(assertTextFits(doc, '.class-card').failures.length, 0, 'fixed UI is clipped by the viewport, not the zero-height body');
        viewportHeight = 50;
        assert.throws(() => assertTextFits(doc, '.class-card'), /body/);
        doc.body.style.overflowY = 'auto'; doc.body.style.overflowX = 'auto';
        assert.equal(assertTextFits(doc, '.class-card').failures.length, 0, 'scrollable content remains reachable');
    } finally { dom.window.close(); }
});

test('measurement never silently passes under jsdom without a layout engine', () => {
    const dom = new JSDOM('<button class="class-card">HUNTER</button>');
    try { assert.throws(() => inspectTextOverflow(dom.window.document), /real layout engine/); }
    finally { dom.window.close(); }
});

test('preview states use the live home, lobby, team cards, HUD and scoreboard markup', () => {
    for (const state of layoutStates) for (const touch of [false, true]) {
        const fixture = createTextLayoutFixture(state, touch);
        try {
            const home = document.getElementById('home')!;
            assert.equal(home.querySelector('.class-card, [data-home-class], [data-class]'), null, 'class selection belongs only in the lobby');
            assert.equal(home.closest('.hidden') === null, state === 'home');
            if (state === 'home') {
                assert.ok(document.querySelector('.room-panel')!.classList.contains('hidden'));
                for (const selector of ['.home-profile input', '#home-create', '#home-join']) {
                    assert.ok(home.querySelector(selector)!.matches(layoutTargets), `${selector} is checked for overflow`);
                }
            }
            if (state.startsWith('lobby')) {
                const sidebar = document.querySelector('.room-sidebar')!;
                assert.equal(sidebar.closest('.hidden'), null, `${state} must render the class picker`);
                const cards = [...sidebar.querySelectorAll('.class-card')];
                assert.deepEqual(cards.map(c => c.querySelector('strong')!.textContent), CLASS_IDS.map(id => CLASSES[id].name));
                assert.deepEqual(cards.map(c => c.querySelector('small')!.textContent), CLASS_IDS.map(id => CLASSES[id].role));
                for (const card of cards) for (const target of [card, card.querySelector('strong')!, card.querySelector('small')!]) {
                    assert.equal(target.closest('.hidden'), null, `${state}: ${target.textContent} must be visible`);
                    assert.ok(target.matches(layoutTargets), `${state}: ${target.textContent} is checked for overflow`);
                }
                assert.equal(document.querySelectorAll('.lineup-card').length, state === 'lobby-full' ? 17 : 6);
            }
            assert.equal(document.documentElement.classList.contains('touch-device'), touch);
            if (state === 'scoreboard') assert.equal(document.querySelectorAll('#board-table tbody tr').length, 17);
            if (state === 'hud') assert.ok(!document.getElementById('hud')!.classList.contains('hidden'));
        } finally { fixture.restore(); }
    }
});
