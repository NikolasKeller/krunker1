import { assertTextFits, inspectTextOverflow } from './text-overflow';

// Every generated page automatically measures actual text after its embedded font loads.
// External screenshot automation can await ready, inspect report, and call assert().
const preview = {
    ready: false,
    report: undefined as ReturnType<typeof inspectTextOverflow> | undefined,
    assert: () => {
        if (!preview.ready) throw new Error('Wait for __textLayout.ready before asserting.');
        return assertTextFits(document);
    },
    measure: () => preview.report = inspectTextOverflow(document),
};
Object.assign(window, { __textLayout: preview });
if (new URLSearchParams(location.search).has('stress')) {
    for (const text of document.querySelectorAll('.class-card strong, .class-card small')) text.textContent += ' gypqj LongUnbrokenPlaystyleName';
}
async function measure() {
    preview.ready = false;
    await document.fonts.ready;
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    preview.measure();
    preview.ready = true;
    document.documentElement.dataset.textLayout = preview.report!.failures.length ? 'fail' : 'pass';
    if (preview.report!.failures.length) console.error('Text layout regression', preview.report);
}
window.addEventListener('resize', () => void measure());
void measure();
