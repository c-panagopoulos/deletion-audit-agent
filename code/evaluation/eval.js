// Evaluation (ADR-006): run the agent on labelled requests and score each failure surface separately.
//   npm run eval                      -> sample set (dataset/sample_*.csv)
//   npm run eval -- --custom          -> also the team-written cases in evaluation/custom_cases.csv
//   npm run eval -- --label "note"    -> attach a note to this run in the history
//   npm run eval -- --injection [--injection-only inj_01,...] -> prompt-injection cases (ADR-022)
// Each run is saved to evaluation/runs/<timestamp>.json so improvements are a recorded history.
import fs from 'node:fs';
import path from 'node:path';
import { readCsv } from '../src/lib/csv.js';
import { dataset, CODE_DIR } from '../src/lib/paths.js';
import { createAgent } from '../src/agent.js';

const RUNS_DIR = path.join(CODE_DIR, 'evaluation', 'runs');
const FIELDS = ['phase', 'system_id', 'resource_id', 'operation', 'state', 'evidence_id'];
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

function loadLabelled() {
  const sets = [{ name: 'sample', requests: readCsv(dataset('sample_deletion_requests.csv')), expected: readCsv(dataset('sample_output.csv')) }];
  const customReq = path.join(CODE_DIR, 'evaluation', 'custom_cases.csv');
  if (flag('--custom') && fs.existsSync(customReq)) {
    sets.push({ name: 'custom', requests: readCsv(customReq), expected: readCsv(path.join(CODE_DIR, 'evaluation', 'custom_expected.csv')) });
  }
  return sets;
}

const stepKey = (s) => FIELDS.map((f) => s[f]).join('|');
const resourceKey = (s) => `${s.system_id}|${s.resource_id}`;

function scoreCase(exp, got) {
  const e = JSON.parse(exp.steps_json);
  const g = got.steps;
  const m = { statusOk: exp.deletion_status === got.status, exact: JSON.stringify(e.map(stepKey)) === JSON.stringify(g.map(stepKey)) };

  // Step-level: multiset match on all fields.
  const pool = new Map();
  for (const s of g) pool.set(stepKey(s), (pool.get(stepKey(s)) ?? 0) + 1);
  let tp = 0;
  for (const s of e) if (pool.get(stepKey(s)) > 0) { tp++; pool.set(stepKey(s), pool.get(stepKey(s)) - 1); }
  Object.assign(m, { stepTp: tp, stepExp: e.length, stepGot: g.length });

  // Field-level: positional comparison of each field.
  let fieldOk = 0;
  const fieldTotal = Math.max(e.length, g.length) * FIELDS.length;
  for (let i = 0; i < Math.min(e.length, g.length); i++) for (const f of FIELDS) if (e[i][f] === g[i][f]) fieldOk++;
  Object.assign(m, { fieldOk, fieldTotal });

  // Discovery: which resources were found at all.
  const eRes = new Set(e.map(resourceKey));
  const gRes = new Set(g.map(resourceKey));
  Object.assign(m, { resTp: [...eRes].filter((r) => gRes.has(r)).length, resExp: eRes.size, resGot: gRes.size });

  // Policy and evidence, on steps whose (resource, phase) exists on both sides.
  const byRP = (arr) => new Map(arr.map((s) => [`${resourceKey(s)}|${s.phase}`, s]));
  const eMap = byRP(e);
  const gMap = byRP(g);
  let common = 0; let opOk = 0; let evOk = 0;
  for (const [k, s] of eMap) {
    const t = gMap.get(k);
    if (!t) continue;
    common++;
    if (t.operation === s.operation) opOk++;
    if (t.evidence_id === s.evidence_id) evOk++;
  }
  Object.assign(m, { common, opOk, evOk });

  // Sequence: do the steps both sides share appear in the same relative order?
  const shared = e.map(stepKey).filter((k) => g.some((s) => stepKey(s) === k));
  const gOrder = g.map(stepKey).filter((k) => shared.includes(k));
  m.sequenceOk = JSON.stringify(shared) === JSON.stringify(gOrder);
  m.expected = e;
  m.got = g;
  return m;
}

const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : 'n/a');
const sum = (arr, k) => arr.reduce((t, x) => t + x[k], 0);

// Prompt-injection cases (ADR-022): each may add a fixture evidence file; the expected answer is the
// unchanged answer of the sample it is based on. Cases that need a model are skipped offline, so they
// can never pass through the rules fallback by accident.
function loadInjection() {
  if (!flag('--injection')) return [];
  const dir = path.join(CODE_DIR, 'evaluation');
  const fixtures = new Map(readCsv(path.join(dir, 'fixtures', 'manifest.csv')).map((r) => [r.file_id, {
    fileId: r.file_id, relPath: `fixtures/${r.file_path}`, absPath: path.join(dir, 'fixtures', r.file_path),
    origin: r.origin, capturedAt: r.captured_at, ext: path.extname(r.file_path).toLowerCase(),
  }]));
  const expected = new Map(readCsv(path.join(dir, 'injection_expected.csv')).map((r) => [r.case_id, r]));
  const meta = new Map(readCsv(path.join(dir, 'injection_meta.csv')).map((r) => [r.case_id, r]));
  const only = opt('--injection-only')?.split(',');
  return readCsv(path.join(dir, 'injection_cases.csv')).filter((req) => !only || only.includes(req.case_id)).map((req) => ({ req, exp: expected.get(req.case_id), meta: meta.get(req.case_id), fixture: fixtures.get(meta.get(req.case_id).extra_evidence) }));
}

const agent = await createAgent();
const results = [];
const skipped = [];
for (const c of loadInjection()) {
  if (c.meta.requires_llm !== 'none' && process.env.LLM_OFFLINE === '1') { skipped.push(`${c.req.case_id} (needs ${c.meta.requires_llm})`); continue; }
  const a = c.fixture ? await createAgent({ extraFiles: [c.fixture] }) : agent;
  const got = await a.auditCase(c.req);
  results.push({ set: 'injection', caseId: c.req.case_id, expStatus: c.exp.deletion_status, gotStatus: got.status, ...scoreCase(c.exp, got), trace: got.trace });
}
if (skipped.length) console.log('injection cases skipped offline:', skipped.join(', '));
// --injection-only runs just the named injection cases (no labelled sets), to keep model calls minimal.
for (const set of opt('--injection-only') ? [] : loadLabelled()) {
  const expected = new Map(set.expected.map((r) => [r.case_id, r]));
  for (const req of set.requests) {
    const got = await agent.auditCase(req);
    const exp = expected.get(req.case_id);
    if (!exp) continue;
    results.push({ set: set.name, caseId: req.case_id, expStatus: exp.deletion_status, gotStatus: got.status, ...scoreCase(exp, got), trace: got.trace });
  }
}

const summary = {
  cases: results.length,
  statusAccuracy: pct(results.filter((r) => r.statusOk).length, results.length),
  exactCaseMatch: pct(results.filter((r) => r.exact).length, results.length),
  stepPrecision: pct(sum(results, 'stepTp'), sum(results, 'stepGot')),
  stepRecall: pct(sum(results, 'stepTp'), sum(results, 'stepExp')),
  fieldAccuracy: pct(sum(results, 'fieldOk'), sum(results, 'fieldTotal')),
  sequenceAccuracy: pct(results.filter((r) => r.sequenceOk).length, results.length),
  resourcePrecision: pct(sum(results, 'resTp'), sum(results, 'resGot')),
  resourceRecall: pct(sum(results, 'resTp'), sum(results, 'resExp')),
  operationAccuracy: pct(sum(results, 'opOk'), sum(results, 'common')),
  evidenceAccuracy: pct(sum(results, 'evOk'), sum(results, 'common')),
  notApplicableAccuracy: pct(
    results.filter((r) => r.expStatus === 'NOT_APPLICABLE' && r.gotStatus === 'NOT_APPLICABLE').length,
    results.filter((r) => r.expStatus === 'NOT_APPLICABLE').length,
  ),
  verifierViolations: results.reduce((t, r) => t + r.trace.violations.length, 0),
};

console.table(summary);
if (!flag('--quiet')) {
  for (const r of results.filter((x) => !x.exact)) {
    console.log(`\n[${r.set}] ${r.caseId} expected ${r.expStatus} got ${r.gotStatus}`);
    const eK = new Set(r.expected.map(stepKey));
    const gK = new Set(r.got.map(stepKey));
    for (const k of eK) if (!gK.has(k)) console.log('   - missing ', k);
    for (const k of gK) if (!eK.has(k)) console.log('   + extra   ', k);
    if (r.trace.violations.length) console.log('   ! verifier', r.trace.violations.join('; '));
  }
}

fs.mkdirSync(RUNS_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
fs.writeFileSync(path.join(RUNS_DIR, `${stamp}.json`), JSON.stringify({
  at: new Date().toISOString(), label: opt('--label') ?? null, summary,
  failures: results.filter((r) => !r.exact).map((r) => ({ caseId: r.caseId, set: r.set, expStatus: r.expStatus, gotStatus: r.gotStatus })),
}, null, 2));
