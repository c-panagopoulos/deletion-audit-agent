// Verifier (ADR-004): rule-based checks on every case result before it is written.
// Returns a list of violations; an empty list means the result satisfies the output contract.
import { OPERATION_META, sortSteps } from './planner.js';

export function verifyCase(result, { auditAt, evidenceCapturedAt }) {
  const v = [];
  const { status, steps } = result;
  if (!['COMPLETE', 'INCOMPLETE', 'NOT_APPLICABLE'].includes(status)) v.push(`invalid status ${status}`);
  if (status === 'NOT_APPLICABLE' && steps.length) v.push('NOT_APPLICABLE must have no steps');
  if (status === 'COMPLETE' && steps.some((s) => s.phase !== 'VERIFICATION')) v.push('COMPLETE may contain only verification steps');
  // A COMPLETE verdict must be proven; with no verification step nothing was checked (e.g. no
  // evidence about the subject existed at audit_at). Flag only: the result is not changed.
  if (status === 'COMPLETE' && !steps.length) v.push('COMPLETE with no verification step: nothing proves the deletion');
  if (status === 'INCOMPLETE' && !steps.some((s) => s.phase === 'FINDING')) v.push('INCOMPLETE must report at least one finding');

  steps.forEach((s, i) => {
    if (s.step_no !== i + 1) v.push(`step_no ${s.step_no} at position ${i + 1}`);
    const meta = OPERATION_META[s.operation];
    if (!meta) { v.push(`unknown operation ${s.operation}`); return; }
    if (meta[0] !== s.phase || meta[1] !== s.state) v.push(`${s.operation} has phase/state ${s.phase}/${s.state}`);
    const future = s.phase === 'REMEDIATION' || (status === 'INCOMPLETE' && s.phase === 'VERIFICATION');
    if (future && s.evidence_id !== '') v.push(`${s.operation} ${s.resource_id} is future work and must not cite evidence`);
    if (!future && !s.evidence_id) v.push(`${s.operation} ${s.resource_id} must cite evidence`);
    const cap = evidenceCapturedAt(s.evidence_id);
    if (s.evidence_id && cap && cap > auditAt) v.push(`${s.evidence_id} captured after audit_at`);
  });

  const sorted = sortSteps(steps);
  if (JSON.stringify(sorted) !== JSON.stringify(steps)) v.push('steps are not in canonical order');
  return v;
}
