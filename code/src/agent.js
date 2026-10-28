// Orchestrates one audit case through the roles of ADR-003:
// Intake -> Identity Resolver -> Investigator -> Policy Engine + Planner -> Verifier.
import { ingestEvidence } from './ingest/index.js';
import { loadIdentities, resolveSubject } from './identity.js';
import { EvidenceIndex, investigate, loadActivity } from './investigate.js';
import { loadRules } from './policy.js';
import { plan, DEFAULT_PLAN_OPTIONS } from './planner.js';
import { verifyCase } from './verifier.js';
import { createIntentClassifier } from './intake.js';
import { createLlm } from './llm/index.js';

export async function createAgent({ llm = createLlm(), planOptions = DEFAULT_PLAN_OPTIONS, onEvent = () => {}, extraFiles = [] } = {}) {
  const classifyIntent = createIntentClassifier(llm);
  const { files, observations, report } = await ingestEvidence({ llm, onEvent, extraFiles, saveReport: !extraFiles.length });
  const index = new EvidenceIndex(observations, files, loadActivity());
  const users = loadIdentities();
  const rules = loadRules();
  const capturedAt = new Map(files.map((f) => [f.fileId, f.capturedAt]));

  async function auditCase(request) {
    const trace = { caseId: request.case_id };
    const intent = await classifyIntent(request.request_text);
    trace.intent = intent;
    let result;
    if (intent.intent !== 'DELETION') {
      result = { status: 'NOT_APPLICABLE', steps: [] };
    } else {
      const subject = resolveSubject(users, request.email, request.audit_at);
      const { resources } = investigate(index, subject, request.audit_at);
      result = plan(rules, resources, planOptions);
      trace.subject = { userId: subject.userId, identifiers: subject.identifiers.map((i) => `${i.field}:${i.source}`) };
      trace.resources = result.decisions.map((d) => ({
        resourceId: d.resource.resourceId, category: d.category, action: d.action, state: d.resource.latest.state,
        evidence: d.resource.latest.fileId, via: d.resource.link.via.map((v) => v.type),
      }));
    }
    trace.violations = verifyCase(result, { auditAt: request.audit_at, evidenceCapturedAt: (id) => capturedAt.get(id) });
    onEvent({ type: 'case_audited', caseId: request.case_id, status: result.status, steps: result.steps.length, violations: trace.violations.length });
    return { caseId: request.case_id, status: result.status, steps: result.steps, trace };
  }

  return { auditCase, ingestReport: report, usage: llm.usage };
}
