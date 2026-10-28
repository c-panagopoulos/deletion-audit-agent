// Policy Engine (ADR-003): decide the required treatment of each resource from deletion_rules.csv.
// The rules file is the source of truth for category -> action; code only classifies resources into
// categories and compares the observed state with the state the action requires.
import { readCsv } from './lib/csv.js';
import { dataset } from './lib/paths.js';

export function loadRules() {
  const rules = new Map();
  for (const r of readCsv(dataset('deletion_rules.csv'))) rules.set(r.data_category, r);
  return rules;
}

const PREFIX_CATEGORY = [
  ['account_', 'USER_PROFILE'],
  ['search_', 'SEARCH_INDEX_ENTRY'],
  ['analytics_', 'ANALYTICS_PROFILE'],
  ['export_', 'USER_EXPORT'],
  ['data_flow_', 'DATA_FLOW'],
  ['backup_', 'BACKUP_ARCHIVE'],
  ['audit_record_', 'SECURITY_AUDIT_LOG'],
  ['tombstone_', 'ACCOUNT_TOMBSTONE'],
  ['legal_hold_', 'LEGAL_HOLD_RECORD'],
  ['cache_', 'CACHE_ENTRY'],
  ['email_delivery_', 'EMAIL_DELIVERY_LOG'],
  ['marketing_', 'MARKETING_PROFILE'],
  ['telemetry_', 'PRODUCT_TELEMETRY'],
];

// Category of a resource: an explicit record_type from evidence wins; otherwise infer from the prefix.
// Support records are either conversations (kept and redacted because they carry shared context) or
// attachments/contact entries that belong only to the subject (deleted).
export function categorize(resource) {
  const seenAll = [...resource.history, resource.latest];
  // Experimental (off unless CATEGORY_TEXT_OVER_VISION=1, see ADR-021): a record type stated by text
  // evidence outranks one inferred by the vision model.
  const textFirst = process.env.CATEGORY_TEXT_OVER_VISION === '1';
  const pick = (obs) => obs.map((o) => o.category).filter(Boolean).pop();
  const explicit = (textFirst && pick(seenAll.filter((o) => o.source !== 'vision'))) || pick(seenAll);
  if (explicit && explicit !== 'DATA_FLOW') return explicit;
  const rid = resource.resourceId;
  if (rid.startsWith('support_')) {
    const seen = [...resource.history, resource.latest];
    const isMessage = seen.some((o) => o.state === 'IDENTIFIABLE' || o.state === 'REDACTED');
    return isMessage ? 'SUPPORT_MESSAGE' : 'SUPPORT_ATTACHMENT';
  }
  return PREFIX_CATEGORY.find(([p]) => rid.startsWith(p))?.[1] ?? null;
}

// The action a category requires. Data flows are not a data category in the rules file: any active
// flow that can copy the subject's data must be disabled before deletion is complete.
export function requiredAction(rules, category) {
  if (category === 'DATA_FLOW') return 'DISABLE';
  return rules.get(category)?.required_action ?? null;
}

// Compare observed state with what policy requires. Returns { compliant, finding, remediation, verify }.
export function evaluate(category, action, state) {
  const present = state !== 'ABSENT';
  switch (action) {
    case 'DELETE':
      return present
        ? { compliant: false, finding: 'REPORT_REMAINING_RECORD', remediation: 'DELETE_RECORD', verify: 'VERIFY_RECORD_ABSENT' }
        : { compliant: true, verify: 'VERIFY_RECORD_ABSENT' };
    case 'REDACT':
      if (!present) return { compliant: true, verify: null };
      return state === 'REDACTED'
        ? { compliant: true, verify: 'VERIFY_RECORD_REDACTED' }
        : { compliant: false, finding: 'REPORT_EXPOSED_PII', remediation: 'REDACT_RECORD', verify: 'VERIFY_RECORD_REDACTED' };
    case 'ANONYMIZE':
      if (!present) return { compliant: true, verify: null };
      return state === 'ANONYMIZED'
        ? { compliant: true, verify: 'VERIFY_RECORD_ANONYMIZED' }
        : { compliant: false, finding: 'REPORT_EXPOSED_PII', remediation: 'ANONYMIZE_RECORD', verify: 'VERIFY_RECORD_ANONYMIZED' };
    case 'DISABLE':
      if (!present) return { compliant: true, verify: null };
      return state === 'ACTIVE'
        ? { compliant: false, finding: 'REPORT_ACTIVE_DATA_FLOW', remediation: 'DISABLE_DATA_FLOW', verify: 'VERIFY_DATA_FLOW_DISABLED' }
        : { compliant: true, verify: 'VERIFY_DATA_FLOW_DISABLED' };
    case 'RETAIN':
      if (category === 'BACKUP_ARCHIVE') {
        if (!present) return { compliant: true, verify: null };
        return state === 'ACTIVE'
          ? { compliant: false, finding: 'REPORT_RESTORE_RISK', remediation: 'BLOCK_RESTORE', verify: 'VERIFY_RESTORE_BLOCKED' }
          : { compliant: true, verify: 'VERIFY_RESTORE_BLOCKED' };
      }
      return present ? { compliant: true, verify: 'VERIFY_RECORD_PRESENT' } : { compliant: true, verify: null, missingRetained: true };
    default:
      return null;
  }
}
