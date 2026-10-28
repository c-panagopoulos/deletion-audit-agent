// Prints the ingest report: per-file status, observation counts and state distribution.
// Usage: npm run ingest:debug [resource_id ...]
import { ingestEvidence } from './index.js';
import { createLlm } from '../llm/index.js';

const llm = createLlm();
const { observations, report } = await ingestEvidence({ llm });
console.log('model calls:', llm.usage.filter((u) => !u.cached).length, 'cached:', llm.usage.filter((u) => u.cached).length);
const byStatus = {};
for (const r of report) {
  byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  if (r.status !== 'ok' || r.observations === 0) console.log(`${r.fileId} ${r.status} ${r.path} ${r.error ?? r.note ?? 'no observations'}`);
}
const states = {};
for (const o of observations) states[`${o.system}:${o.state}`] = (states[`${o.system}:${o.state}`] ?? 0) + 1;
console.log('\nfiles:', byStatus, '\nobservations:', observations.length);
console.table(Object.entries(states).sort().map(([k, n]) => ({ system_state: k, n })));

for (const id of process.argv.slice(2)) {
  console.log(`\n== ${id}`);
  for (const o of observations.filter((x) => x.resourceId === id)) {
    console.log(o.at, o.fileId, o.state, o.category ?? '', o.source, 'links=', o.links.join(' '), 'pii=', o.pii.join(','));
  }
}
