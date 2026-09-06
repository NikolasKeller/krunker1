import { writeFileSync } from 'node:fs';
import { edgeSession } from './movement-edge-session';
const report = edgeSession();
writeFileSync(process.env.EDGE_REPORT ?? '/tmp/movement-edges.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, failures: report.failures.slice(0, 2) }, null, 2));
