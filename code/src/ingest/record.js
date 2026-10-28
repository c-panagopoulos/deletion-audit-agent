// Shared mapper: every evidence format (SQL row, JSON record, log trace, text line) ends up here
// and becomes one "resource observation":
//
//   { fileId, at, system, resourceId, state, explicit, links[], pii[], attrs{}, category? }
//
// state is one of PRESENT | ABSENT | IDENTIFIABLE | ANONYMIZED | REDACTED | ACTIVE | DISABLED | BLOCKED.
// links are the raw identifier values that tie the record to a person (emails, user ids, hashes...).
// pii lists the direct identifiers the record still exposes.

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// The system that owns each resource-id prefix.
const PREFIX_SYSTEM = [
  ['account_', 'account_service'],
  ['search_', 'search_service'],
  ['analytics_', 'analytics_platform'],
  ['support_', 'support_platform'],
  ['export_', 'export_service'],
  ['data_flow_', 'integration_service'],
  ['backup_', 'backup_service'],
  ['audit_record_', 'security_service'],
  ['tombstone_', 'identity_service'],
  ['legal_hold_', 'legal_service'],
  ['cache_', 'cache_service'],
  ['email_delivery_', 'email_delivery_service'],
  ['marketing_', 'marketing_platform'],
  ['telemetry_', 'telemetry_service'],
];

export function systemFor(resourceId) {
  const hit = PREFIX_SYSTEM.find(([p]) => resourceId.startsWith(p));
  return hit ? hit[1] : null;
}

export const RESOURCE_ID_RE = /\b(?:account|search|analytics|support|export|data_flow|backup|audit_record|tombstone|legal_hold|cache|email_delivery|marketing|telemetry)_\d+\b/;

// Fields that identify the subject of a record (used for linking, not necessarily PII).
const LINK_FIELDS = [
  'customer_reference', 'user_id', 'subject_reference', 'subject_ref', 'email', 'owner_email',
  'uploaded_by', 'subject_selector', 'lookup_value', 'requester_email', 'customer_email',
  'email_hash', 'phone', 'owner_phone', 'requester_phone', 'matched_value', 'lookup_key',
  'match_key', 'subject_key', 'scan_key', 'owner_key', 'correlation_key',
];

// Direct identifiers that policy requires to be removed from retained/redacted records.
const PII_FIELDS = [
  'full_name', 'name', 'display_name', 'requester_name', 'email', 'owner_email', 'requester_email',
  'customer_email', 'phone', 'owner_phone', 'requester_phone', 'email_hash', 'uploaded_by',
  'matched_value',
];

const isNull = (v) => v === null || v === undefined || v === '' || v === 'null' || v === 'None';
const truthy = (v) => v === true || v === 1 || v === '1' || v === 'true' || v === 'True';
const falsy = (v) => v === false || v === 0 || v === '0' || v === 'false' || v === 'False';

// Flatten one level of nesting (e.g. search documents keep identifiers under `document`).
function flatten(record) {
  const out = {};
  for (const [k, v] of Object.entries(record)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, v);
    else out[k] = v;
  }
  return out;
}

export function collectLinks(rec) {
  const links = new Set();
  for (const f of LINK_FIELDS) if (!isNull(rec[f])) links.add(String(rec[f]));
  for (const text of [rec.message_text, rec.message]) {
    if (typeof text === 'string') for (const m of text.match(EMAIL_RE) ?? []) links.add(m);
  }
  return [...links];
}

export function collectPii(rec) {
  const pii = [];
  for (const f of PII_FIELDS) if (!isNull(rec[f])) pii.push(f);
  if (typeof rec.message_text === 'string' && EMAIL_RE.test(rec.message_text)) pii.push('message_text');
  EMAIL_RE.lastIndex = 0;
  if (truthy(rec.direct_identifiers) || Number(rec.direct_identifiers) > 0) pii.push('direct_identifiers');
  return pii;
}

// Map an explicit record_type/result pair (manifests, handover notes, record_lookup logs).
const RESULT_STATE = {
  FOUND: 'PRESENT', NOT_FOUND: 'ABSENT', IDENTIFIABLE: 'IDENTIFIABLE', ANONYMIZED: 'ANONYMIZED',
  REDACTED: 'REDACTED', ACTIVE: 'ACTIVE', DISABLED: 'DISABLED', BLOCKED: 'BLOCKED',
};

// Derive the state of a resource from the fields of a record that shows it.
function deriveState(resourceId, rec, pii) {
  if (rec.result && RESULT_STATE[rec.result]) return RESULT_STATE[rec.result];
  const sys = systemFor(resourceId);
  if (sys === 'integration_service') {
    if (truthy(rec.enabled) || truthy(rec.scheduler_registered)) return 'ACTIVE';
    if (falsy(rec.enabled)) return 'DISABLED';
  }
  if (sys === 'backup_service') {
    if (truthy(rec.restore_allowed) || (truthy(rec.eligible) && !truthy(rec.deletion_block))) return 'ACTIVE';
    if (falsy(rec.restore_allowed) || truthy(rec.deletion_block) || rec.decision === 'deny') return 'BLOCKED';
  }
  if (sys === 'analytics_platform' || sys === 'identity_service' || sys === 'telemetry_service') {
    const attributable = pii.length > 0 || !isNull(rec.user_id) || !isNull(rec.customer_reference);
    if (sys === 'identity_service') return pii.length ? 'IDENTIFIABLE' : 'REDACTED';
    return attributable ? 'IDENTIFIABLE' : 'ANONYMIZED';
  }
  if (sys === 'support_platform' && (rec.message_text !== undefined || 'requester_email' in rec || 'requester_name' in rec)) {
    return pii.length ? 'IDENTIFIABLE' : 'REDACTED';
  }
  return 'PRESENT';
}

// Build an observation from a plain record. `ctx` = { fileId, at, system?, category?, state?, explicit? }
export function observe(record, ctx) {
  const rec = flatten(record);
  const resourceId = rec.resource_id;
  if (!resourceId || !RESOURCE_ID_RE.test(resourceId)) return null;
  const pii = collectPii(rec);
  const state = ctx.state ?? deriveState(resourceId, rec, pii);
  return {
    fileId: ctx.fileId,
    at: ctx.at,
    system: ctx.system ?? rec.system ?? systemFor(resourceId),
    resourceId,
    state,
    explicit: ctx.explicit ?? true,
    category: rec.record_type ?? ctx.category ?? null,
    links: collectLinks(rec),
    pii: state === 'ABSENT' ? [] : pii,
    attrs: pickAttrs(rec),
    source: ctx.source,
  };
}

// Keep the few non-identifier attributes the policy engine needs.
function pickAttrs(rec) {
  const keep = ['retention_until', 'retained_until', 'event_code', 'event_name', 'storage_class', 'file_name',
    'file', 'download_available', 'available', 'connector_name', 'account_status', 'email_opt_in', 'source_resource_id',
    'collection', 'origin_system', 'index', 'archive_present', 'marker_found'];
  const out = {};
  for (const k of keep) if (!isNull(rec[k])) out[k] = rec[k];
  return out;
}
