// Per-case evaluation table for evaluation_report.md: same scoring as eval.js, one row per case.
// Run offline with the final-run caches:
//   LLM_OFFLINE=1 LLM_TASK_CACHE_VISUAL_EXTRACT=.cache-final-backup node evaluation/case_table.mjs
import fs from 'node:fs';
import path from 'node:path';
import { readCsv } from '../src/lib/csv.js';
import { dataset, CODE_DIR } from '../src/lib/paths.js';
import { createAgent } from '../src/agent.js';

const FIELDS = ['phase', 'system_id', 'resource_id', 'operation', 'state', 'evidence_id'];
const key = (s) => FIELDS.map((f) => s[f]).join('|');
const ev = path.join(CODE_DIR, 'evaluation');
const sets = [
  ['sample', readCsv(dataset('sample_deletion_requests.csv')), readCsv(dataset('sample_output.csv'))],
  ['custom', readCsv(path.join(ev, 'custom_cases.csv')), readCsv(path.join(ev, 'custom_expected.csv'))],
  ['injection', readCsv(path.join(ev, 'injection_cases.csv')).filter((r) => r.case_id !== 'inj_03'), readCsv(path.join(ev, 'injection_expected.csv'))],
];
const agent = await createAgent();
const rows = [];
for (const [set, reqs, exps] of sets) {
  const exp = new Map(exps.map((r) => [r.case_id, r]));
  for (const q of reqs) {
    const e = JSON.parse(exp.get(q.case_id).steps_json);
    const got = await agent.auditCase(q);
    const g = got.steps;
    const pool = new Map(); for (const s of g) pool.set(key(s), (pool.get(key(s)) ?? 0) + 1);
    let tp = 0; for (const s of e) if (pool.get(key(s)) > 0) { tp++; pool.set(key(s), pool.get(key(s)) - 1); }
    let fok = 0; for (let i = 0; i < Math.min(e.length, g.length); i++) for (const f of FIELDS) if (e[i][f] === g[i][f]) fok++;
    const ftot = Math.max(e.length, g.length) * FIELDS.length;
    // Matched-field accuracy: pair each expected step with the predicted step for the same
    // system_id + resource_id (+ phase, since one resource can have a finding, a remediation and a
    // verification step) and compare the 6 fields; unpaired steps are left out (they count in recall).
    const pairKey = (s) => `${s.system_id}|${s.resource_id}|${s.phase}`;
    const gByPair = new Map(g.map((s) => [pairKey(s), s]));
    let mPairs = 0; let mok = 0;
    for (const s of e) { const t = gByPair.get(pairKey(s)); if (!t) continue; mPairs++; for (const f of FIELDS) if (s[f] === t[f]) mok++; }
    const mtot = mPairs * FIELDS.length;
    const shared = e.map(key).filter((k) => g.some((s) => key(s) === k));
    const seqOk = JSON.stringify(shared) === JSON.stringify(g.map(key).filter((k) => shared.includes(k)));
    const missing = e.filter((s) => !g.some((t) => key(t) === key(s))).map((s) => `${s.operation} ${s.resource_id}`);
    const extra = g.filter((s) => !e.some((t) => key(t) === key(s))).map((s) => `${s.operation} ${s.resource_id}`);
    rows.push({ set, case_id: q.case_id, expStatus: exp.get(q.case_id).deletion_status, gotStatus: got.status, tp, expSteps: e.length, gotSteps: g.length, fok, ftot, mok, mtot, mPairs, seqOk, exact: JSON.stringify(e.map(key)) === JSON.stringify(g.map(key)), missing, extra, intent: got.trace.intent.method });
  }
}
fs.writeFileSync(path.join(ev, 'case_table.json'), JSON.stringify(rows, null, 1));
const sum = (k, r = rows) => r.reduce((t, x) => t + x[k], 0);
for (const scope of [['37 tuning cases (32 samples + 5 custom)', rows.filter((r) => r.set !== 'injection')], ['all 39 measured offline', rows]]) {
  const r = scope[1];
  console.log(`${scope[0]}: status ${r.filter((x) => x.expStatus === x.gotStatus).length}/${r.length}, steps recall ${sum('tp', r)}/${sum('expSteps', r)}, precision ${sum('tp', r)}/${sum('gotSteps', r)}, fields ${sum('fok', r)}/${sum('ftot', r)}, matched fields ${sum('mok', r)}/${sum('mtot', r)} on ${sum('mPairs', r)} paired steps, sequence ${r.filter((x) => x.seqOk).length}/${r.length}, exact ${r.filter((x) => x.exact).length}/${r.length}, intents ${[...new Set(r.map((x) => x.intent))]}`);
}
