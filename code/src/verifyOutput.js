// File-level Verifier (ADR-012): re-reads output.csv from disk after it is written and checks the
// submission contract. The per-case Verifier (verifier.js) cannot see these failures: a quoting bug,
// a missing or duplicated row, or a wrong row order only exist once the whole file is serialized.
//
//   node src/verifyOutput.js [output.csv]   -> exit code 1 if any check fails
import fs from 'node:fs';
import path from 'node:path';
import { parseCsv } from './lib/csv.js';
import { dataset, REPO_ROOT } from './lib/paths.js';

const HEADER = 'case_id,deletion_status,steps_json';
const STATUSES = new Set(['COMPLETE', 'INCOMPLETE', 'NOT_APPLICABLE']);

export function verifyOutput(outputPath, {
  requestsPath = dataset('deletion_requests.csv'),
  templatePath = dataset('output.csv'),
  samplesPath = dataset('sample_deletion_requests.csv'),
} = {}) {
  const errors = [];
  const raw = fs.readFileSync(outputPath, 'utf8');
  const firstLine = raw.split(/\r?\n/, 1)[0].replace(/^﻿/, '');
  if (firstLine !== HEADER) errors.push(`header is "${firstLine}", expected "${HEADER}"`);

  const rows = parseCsv(raw);
  const requests = parseCsv(fs.readFileSync(requestsPath, 'utf8')).map((r) => r.case_id);
  const template = parseCsv(fs.readFileSync(templatePath, 'utf8')).map((r) => r.case_id);
  const samples = new Set(parseCsv(fs.readFileSync(samplesPath, 'utf8')).map((r) => r.case_id));

  // Count and identity of rows against the requests file.
  if (rows.length !== requests.length) errors.push(`${rows.length} data rows, expected ${requests.length}`);
  const seen = new Map();
  for (const r of rows) seen.set(r.case_id, (seen.get(r.case_id) ?? 0) + 1);
  const dups = [...seen].filter(([, n]) => n > 1).map(([id]) => id);
  const missing = requests.filter((id) => !seen.has(id));
  const unknown = [...seen.keys()].filter((id) => !requests.includes(id));
  if (dups.length) errors.push(`duplicate case_id: ${dups.join(', ')}`);
  if (missing.length) errors.push(`missing case_id: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ` (+${missing.length - 10})` : ''}`);
  if (unknown.length) errors.push(`case_id not in requests: ${unknown.slice(0, 10).join(', ')}`);
  const leaked = rows.filter((r) => samples.has(r.case_id)).map((r) => r.case_id);
  if (leaked.length) errors.push(`sample cases present in output: ${leaked.join(', ')}`);

  // Row order: the organizers' template when it lists cases, otherwise the organizers' request file.
  const reference = template.length ? { name: 'output.csv template', ids: template } : { name: 'deletion_requests.csv row order (template has no data rows)', ids: requests };
  const order = rows.map((r) => r.case_id);
  const firstDiff = order.findIndex((id, i) => id !== reference.ids[i]);
  if (firstDiff !== -1 || order.length !== reference.ids.length) {
    errors.push(`row order differs from ${reference.name} at row ${firstDiff + 1}: got ${order[firstDiff]}, expected ${reference.ids[firstDiff]}`);
  }

  // Every row: valid status and a steps_json that parses to an array after the CSV round-trip.
  for (const r of rows) {
    if (!STATUSES.has(r.deletion_status)) errors.push(`${r.case_id}: invalid deletion_status "${r.deletion_status}"`);
    let steps;
    try { steps = JSON.parse(r.steps_json); } catch (e) { errors.push(`${r.case_id}: steps_json is not valid JSON (${e.message})`); continue; }
    if (!Array.isArray(steps)) errors.push(`${r.case_id}: steps_json is not a JSON array`);
    else if (r.deletion_status === 'NOT_APPLICABLE' && steps.length) errors.push(`${r.case_id}: NOT_APPLICABLE with ${steps.length} steps`);
  }

  return { ok: errors.length === 0, errors, rows: rows.length, orderReference: reference.name };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const target = process.argv[2] ?? path.join(REPO_ROOT, 'output.csv');
  const res = verifyOutput(target);
  console.log(`${res.ok ? 'PASS' : 'FAIL'} ${target}: ${res.rows} rows, order checked against ${res.orderReference}`);
  for (const e of res.errors) console.log(`  - ${e}`);
  process.exit(res.ok ? 0 : 1);
}
