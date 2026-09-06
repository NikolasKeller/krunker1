import { mkdir, writeFile } from 'node:fs/promises';
import { model } from './model';
const cases = (['matched-quantiles', 'blackout-stress'] as const).flatMap(profile =>
    (['loss-recovery', 'shared-queue'] as const).map(cause => {
        const { tcpTrace, unreliableTrace, ...summary } = model(profile, cause);
        return summary;
    }));
const report = { date: new Date().toISOString(), evidence: 'synthetic sensitivity analysis only; not acceptance evidence', cases };
await mkdir('artifacts/transport', { recursive: true });
await writeFile('artifacts/transport/model.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
