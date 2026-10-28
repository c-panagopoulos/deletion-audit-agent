// JSON evidence. Four shapes are recognised by structure, not by file name:
//   - snapshot bundles:   { snapshots: [{ captured_at, data_store, collection, records[] }] }
//   - service exports:    { service_exports: { <system>: { <list>: [ { observed_at, resource_id, ... } ] } } }
//   - record manifests:   { records: [{ recorded_at, system, resource_id, record_type, result, subject_reference }] }
//   - collection dumps:   { captured_at, collection, records[] }
import fs from 'node:fs';
import { observe } from './record.js';

export function readJson(file) {
  const doc = JSON.parse(fs.readFileSync(file.absPath, 'utf8'));
  const observations = [];
  const covered = new Set();
  const push = (obs) => {
    if (!obs) return;
    observations.push(obs);
    covered.add(obs.system);
  };
  const base = { fileId: file.fileId };

  if (Array.isArray(doc.snapshots)) {
    for (const snap of doc.snapshots) {
      for (const rec of snap.records ?? []) {
        if (rec.result) {
          // operational_record_history rows carry their own record_type/result.
          push(observe(rec, { ...base, at: rec.recorded_at ?? snap.captured_at, system: rec.system, source: `json:${snap.collection}` }));
        } else {
          push(observe(rec, { ...base, at: snap.captured_at, system: snap.data_store, category: null, source: `json:${snap.collection}` }));
        }
      }
    }
  } else if (doc.service_exports) {
    for (const [system, lists] of Object.entries(doc.service_exports)) {
      for (const [list, items] of Object.entries(lists)) {
        for (const item of items) push(fromServiceExport(system, list, item, base));
      }
    }
  } else if (Array.isArray(doc.records)) {
    for (const rec of doc.records) {
      const at = rec.recorded_at ?? doc.captured_at ?? doc.exported_at ?? file.capturedAt;
      push(observe(rec, { ...base, at, system: rec.system, source: `json:${doc.collection ?? doc.origin ?? 'records'}` }));
    }
  }
  return { observations, coverage: [...covered] };
}

function fromServiceExport(system, list, item, base) {
  const ctx = { ...base, at: item.observed_at, system, source: `json:service_exports.${list}` };
  if (system === 'account_service') {
    if (item.status_code === 404) return observe({ resource_id: item.resource_id }, { ...ctx, state: 'ABSENT' });
    return observe({ resource_id: item.resource_id, ...(item.profile ?? {}) }, { ...ctx, state: 'PRESENT' });
  }
  if (system === 'search_service') {
    const doc = item.hits?.documents?.find((d) => d.resource_id === item.resource_id);
    if (!doc || item.hits?.total === 0) {
      return observe({ resource_id: item.resource_id, lookup_key: item.query }, { ...ctx, state: 'ABSENT' });
    }
    return observe({ ...doc, lookup_key: item.query }, { ...ctx, state: 'PRESENT' });
  }
  return observe(item, ctx);
}
