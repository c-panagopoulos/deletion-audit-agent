// Identity Resolver (ADR-003): find the subject of a request and every identifier they had at audit_at.
// The request email may be current or historical, so lookup covers both the snapshot and the audit log.
import { readCsv } from './lib/csv.js';
import { dataset } from './lib/paths.js';

const IDENTITY_FIELDS = ['name', 'email', 'phone', 'email_hash'];

// Normalize identifier values so "PERSON@EXAMPLE.COM" and "person@example.com", or phone numbers with
// different spacing, compare equal.
export function normalizeId(value) {
  if (value === null || value === undefined) return null;
  const v = String(value).trim();
  if (!v || v === 'null') return null;
  if (v.includes('@')) return v.toLowerCase();
  if (/^\+?[\d\s().-]{7,}$/.test(v)) return `tel:${v.replace(/\D/g, '')}`;
  return v.toLowerCase();
}

export function loadIdentities() {
  const users = new Map();
  for (const u of readCsv(dataset('user_identities.csv'))) users.set(u.user_id, { ...u, changes: [] });
  for (const a of readCsv(dataset('user_audit_log.csv'))) users.get(a.user_id)?.changes.push(a);
  for (const u of users.values()) u.changes.sort((x, y) => x.event_time.localeCompare(y.event_time));
  return users;
}

// Values of each identity field the user held at any time up to `asOf`.
// A field changed after `asOf` was still at its old value then, so the newer value is excluded.
function valuesAsOf(user, asOf) {
  const out = [];
  for (const field of IDENTITY_FIELDS) {
    const changes = user.changes.filter((c) => c.field_name === field);
    const later = changes.find((c) => c.event_time > asOf);
    const current = later ? later.old_value : user[field];
    out.push({ field, value: current, source: 'user_identities', auditId: null });
    for (const c of changes) {
      if (c.event_time > asOf) continue;
      out.push({ field, value: c.old_value, source: 'user_audit_log', auditId: c.audit_id });
    }
  }
  return out.filter((x) => x.value);
}

export function resolveSubject(users, email, asOf) {
  const target = normalizeId(email);
  let subject = null;
  for (const u of users.values()) {
    const all = [u.email, ...u.changes.filter((c) => c.field_name === 'email').flatMap((c) => [c.old_value, c.new_value])];
    if (all.some((e) => normalizeId(e) === target)) { subject = u; break; }
  }
  if (!subject) return { userId: null, identifiers: [{ field: 'email', value: email, source: 'request', auditId: null }], keys: new Set([target]) };

  const identifiers = valuesAsOf(subject, asOf);
  identifiers.push({ field: 'user_id', value: subject.user_id, source: 'user_identities', auditId: null });
  // Names are too ambiguous to link on (e.g. "Jonas Berg" vs "Jonas Berglund"); keep them for display only.
  const keys = new Set(identifiers.filter((i) => i.field !== 'name').map((i) => normalizeId(i.value)));
  return { userId: subject.user_id, name: subject.name, identifiers, keys };
}
