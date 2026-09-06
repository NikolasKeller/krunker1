// Runs in the external renderer, never in the production client. No browser launcher.
export interface Bounds { left: number; right: number; top: number; bottom: number }
export interface TextOverflow { text: string; element: string; container: string; axis: 'x' | 'y' }
export function overflowAxes(text: Bounds, box: Bounds, tolerance = 0.5): ('x' | 'y')[] {
    const axes: ('x' | 'y')[] = [];
    if (text.left < box.left - tolerance || text.right > box.right + tolerance) axes.push('x');
    if (text.top < box.top - tolerance || text.bottom > box.bottom + tolerance) axes.push('y');
    return axes;
}

export const layoutTargets = [
    '.class-card', '.class-card strong', '.class-card small',
    '.home-profile input', '.room-panel input:not([type=range])', '.room-panel select',
    '.lineup-card', '.map-thumb', '.home-actions button', '.lobby-actions button', '.team-heading',
    '.room-options button', '.score-panel th', '.score-panel td',
    '.timer-box', '.ammo-line', '.health-content', '.tactical-card',
].join(', ');
const label = (element: Element) => element.id ? `#${element.id}` : `${element.tagName.toLowerCase()}.${[...element.classList].join('.')}`;
const pixels = (value: string) => parseFloat(value) || 0;

export function inspectTextOverflow(doc: Document, selector = layoutTargets) {
    const view = doc.defaultView!;
    if (!doc.createRange().getClientRects) throw new Error('Text overflow checks require a real layout engine; jsdom cannot measure text.');
    const failures: TextOverflow[] = [];
    let checked = 0;
    for (const target of doc.querySelectorAll<HTMLElement>(selector)) {
        if (!target.getClientRects().length || view.getComputedStyle(target).visibility === 'hidden') continue;
        checked++;
        const style = view.getComputedStyle(target);
        if (target.matches('input, select')) {
            // Native single-line controls may scroll horizontally, but must fit their full line box vertically.
            const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2;
            const available = target.clientHeight - pixels(style.paddingTop) - pixels(style.paddingBottom);
            if (lineHeight > available + 0.5) failures.push({ text: (target as HTMLInputElement).value, element: label(target), container: label(target), axis: 'y' });
            continue;
        }
        const walker = doc.createTreeWalker(target, 4 /* SHOW_TEXT */);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const parent = node.parentElement!;
            if (!node.textContent?.trim() || parent.closest('svg, [aria-hidden=true]') || !parent.getClientRects().length) continue;
            const range = doc.createRange(); range.selectNodeContents(node);
            for (const rect of range.getClientRects()) {
                if (!rect.width || !rect.height) continue;
                const reachable = new Set<'x' | 'y'>();
                for (let container: HTMLElement | null = parent; container; container = container.parentElement) {
                    const css = view.getComputedStyle(container);
                    const overflowX = css.overflowX || css.overflow, overflowY = css.overflowY || css.overflow;
                    const scrollX = /auto|scroll/.test(overflowX), scrollY = /auto|scroll/.test(overflowY);
                    if (scrollX) reachable.add('x');
                    if (scrollY) reachable.add('y');
                    const box = container.getBoundingClientRect();
                    // Body overflow propagates to the viewport. This app's fixed UI leaves body height at zero.
                    const inner = container === doc.body
                        ? { left: 0, top: 0, right: doc.documentElement.clientWidth, bottom: doc.documentElement.clientHeight }
                        : { left: box.left + pixels(css.borderLeftWidth), right: box.right - pixels(css.borderRightWidth),
                            top: box.top + pixels(css.borderTopWidth), bottom: box.bottom - pixels(css.borderBottomWidth) };
                    for (const axis of overflowAxes(rect, inner)) {
                        // Check each component and any clipping ancestor. Offscreen scroll content is reachable, not clipped.
                        const clip = /hidden|clip/.test(axis === 'x' ? overflowX : overflowY);
                        if (!reachable.has(axis) && (container === target || clip)) failures.push({ text: node.textContent.trim(), element: label(parent), container: label(container), axis });
                    }
                    if (container === doc.body) break;
                }
            }
        }
    }
    if (!checked) throw new Error('No visible text components were measured.');
    return { checked, failures: [...new Map(failures.map(f => [JSON.stringify(f), f])).values()] };
}

export function assertTextFits(doc: Document, selector = layoutTargets) {
    const report = inspectTextOverflow(doc, selector);
    if (report.failures.length) throw new Error(`Clipped text: ${JSON.stringify(report.failures, null, 2)}`);
    return report;
}
