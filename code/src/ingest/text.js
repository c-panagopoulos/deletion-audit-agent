// Plain-text handover notes: one pipe-separated line per checked resource.
//   - 2026-01-01T00:00:00Z | account_service | account_000 | USER_PROFILE | NOT_FOUND | person@example.com
import fs from 'node:fs';
import { observe } from './record.js';

const LINE_RE = /^-\s*(\S+)\s*\|\s*(\S+)\s*\|\s*(\S+)\s*\|\s*(\S+)\s*\|\s*(\S+)\s*\|\s*(.+?)\s*$/;

export function readText(file) {
  const observations = [];
  const covered = new Set();
  for (const line of fs.readFileSync(file.absPath, 'utf8').split('\n')) {
    const m = line.match(LINE_RE);
    if (!m) continue;
    const [, at, system, resource_id, record_type, result, subject] = m;
    const subject_reference = /no direct identifier/i.test(subject) ? null : subject;
    const obs = observe({ resource_id, system, record_type, result, subject_reference }, { fileId: file.fileId, at, system, source: 'text:handover' });
    if (obs) { observations.push(obs); covered.add(system); }
  }
  return { observations, coverage: [...covered] };
}
