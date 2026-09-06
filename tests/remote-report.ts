import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { runRemoteSession, type RemoteProfile } from './remote-session';

const cases = (['stable', 'matched-quantiles', 'one-second-stalls', 'four-second-blackout'] as RemoteProfile[])
    .flatMap(profile => [60, 144].flatMap(hz => [false, true].map(dropped => runRemoteSession(profile, hz, dropped))));
const path = process.env.REMOTE_REPORT ?? 'artifacts/remote/after.json';
await mkdir(dirname(path), { recursive: true });
await writeFile(path, JSON.stringify({ evidence: 'Deterministic 120-second production interpolation replay; no browser/GPU or kernel impairment measurement.', cases }, null, 2) + '\n');
console.log(JSON.stringify(cases.filter(c => c.renderHz === 60 && !c.dropped), null, 2));
