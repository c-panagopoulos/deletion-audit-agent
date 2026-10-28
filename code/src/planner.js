// Planner (ADR-003): turn per-resource policy decisions into the ordered steps_json array.
// Order (problem statement): phase FINDING -> REMEDIATION -> VERIFICATION; within a phase, the
// operation order of the allowed-operations table; then system_id, then resource_id ascending.
import { categorize, requiredAction, evaluate } from './policy.js';

export const OPERATION_ORDER = [
  'REPORT_REMAINING_RECORD', 'REPORT_EXPOSED_PII', 'REPORT_ACTIVE_DATA_FLOW', 'REPORT_RESTORE_RISK',
  'DISABLE_DATA_FLOW', 'BLOCK_RESTORE', 'DELETE_RECORD', 'REDACT_RECORD', 'ANONYMIZE_RECORD',
  'VERIFY_RECORD_ABSENT', 'VERIFY_RECORD_PRESENT', 'VERIFY_RECORD_REDACTED', 'VERIFY_RECORD_ANONYMIZED',
  'VERIFY_DATA_FLOW_DISABLED', 'VERIFY_RESTORE_BLOCKED',
];

export const OPERATION_META = {
  REPORT_REMAINING_RECORD: ['FINDING', 'PRESENT'],
  REPORT_EXPOSED_PII: ['FINDING', 'PRESENT'],
  REPORT_ACTIVE_DATA_FLOW: ['FINDING', 'ACTIVE'],
  REPORT_RESTORE_RISK: ['FINDING', 'ACTIVE'],
  DISABLE_DATA_FLOW: ['REMEDIATION', 'DISABLED'],
  BLOCK_RESTORE: ['REMEDIATION', 'BLOCKED'],
  DELETE_RECORD: ['REMEDIATION', 'ABSENT'],
  REDACT_RECORD: ['REMEDIATION', 'REDACTED'],
  ANONYMIZE_RECORD: ['REMEDIATION', 'ANONYMIZED'],
  VERIFY_RECORD_ABSENT: ['VERIFICATION', 'ABSENT'],
  VERIFY_RECORD_PRESENT: ['VERIFICATION', 'PRESENT'],
  VERIFY_RECORD_REDACTED: ['VERIFICATION', 'REDACTED'],
  VERIFY_RECORD_ANONYMIZED: ['VERIFICATION', 'ANONYMIZED'],
  VERIFY_DATA_FLOW_DISABLED: ['VERIFICATION', 'DISABLED'],
  VERIFY_RESTORE_BLOCKED: ['VERIFICATION', 'BLOCKED'],
};

const PHASE_ORDER = ['FINDING', 'REMEDIATION', 'VERIFICATION'];

export function sortSteps(steps) {
  const key = (s) => [PHASE_ORDER.indexOf(s.phase), OPERATION_ORDER.indexOf(s.operation)];
  return [...steps]
    .sort((a, b) => {
      const [pa, oa] = key(a);
      const [pb, ob] = key(b);
      return pa - pb || oa - ob || a.system_id.localeCompare(b.system_id) || a.resource_id.localeCompare(b.resource_id);
    })
    .map((s, i) => ({ ...s, step_no: i + 1 }));
}

const step = (operation, resource, evidenceId) => {
  const [phase, state] = OPERATION_META[operation];
  return { step_no: 0, phase, system_id: resource.system, resource_id: resource.resourceId, operation, state, evidence_id: evidenceId };
};

// Options are explicit so evaluation can compare alternatives (e.g. whether already-absent secondary
// copies get their own verification step).
export const DEFAULT_PLAN_OPTIONS = { verifyAbsentSecondary: false };

export function plan(rules, resources, options = DEFAULT_PLAN_OPTIONS) {
  const decisions = [];
  for (const r of resources) {
    const category = categorize(r);
    const action = requiredAction(rules, category);
    const verdict = action ? evaluate(category, action, r.latest.state) : null;
    decisions.push({ resource: r, category, action, verdict });
  }

  const incomplete = decisions.some((d) => d.verdict && !d.verdict.compliant);
  const steps = [];
  for (const { resource, category, verdict } of decisions) {
    if (!verdict) continue;
    const evidence = resource.latest.fileId ?? resource.latest.activityId ?? '';
    if (!verdict.compliant) {
      steps.push(step(verdict.finding, resource, evidence));
      steps.push(step(verdict.remediation, resource, ''));
    }
    if (!verdict.verify) continue;
    const alreadyAbsentCopy = verdict.compliant && verdict.verify === 'VERIFY_RECORD_ABSENT' && category !== 'USER_PROFILE';
    if (alreadyAbsentCopy && !options.verifyAbsentSecondary) continue;
    steps.push(step(verdict.verify, resource, incomplete ? '' : evidence));
  }
  return { status: incomplete ? 'INCOMPLETE' : 'COMPLETE', steps: sortSteps(steps), decisions };
}
