// Visual evidence (screenshots, PDFs) read by a vision model (ADR-002, ADR-005, ADR-015).
// The model proposes records. The response shape is validated as a whole (a malformed shape gets the
// single corrective retry); records are then validated one by one: valid ones become observations,
// invalid ones are dropped with their reason. Results are cached, so each file costs one model call.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CODE_DIR } from '../lib/paths.js';
import { observe, RESOURCE_ID_RE } from './record.js';
import { DATASET_DIR } from '../lib/paths.js';
import { loadIdentities, normalizeId } from '../identity.js';

const PROMPT = fs.readFileSync(path.join(CODE_DIR, 'prompts', 'visual_extract.md'), 'utf8');
const STATES = ['PRESENT', 'ABSENT', 'IDENTIFIABLE', 'ANONYMIZED', 'REDACTED', 'ACTIVE', 'DISABLED', 'BLOCKED'];
const MIME = { '.png': 'image/png', '.pdf': 'application/pdf' };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Vision transient-failure policy (ADR-013): at most 3 attempts for timeouts and 5xx, 5 s then 15 s apart.
// Anything else (quota, 4xx) fails at once. A failure is never cached, so the file is retried next run.
export const VISION_RETRY = { attempts: 3, delaysMs: [5_000, 15_000], retryable: /timeout|aborted|HTTP 5\d\d|ECONNRESET|fetch failed/i };
const KEEPS_IDENTITY_STATE = /^(analytics|support|tombstone|telemetry|email_delivery)_/;

const ID_FORMAT = new RegExp(`^${RESOURCE_ID_RE.source}$`);

// Shape check only: an unusable response gets the one corrective retry.
function validateShape(out) {
  if (!Array.isArray(out?.records)) return '"records" must be an array';
  if (out.records.some((r) => !r || typeof r !== 'object' || Array.isArray(r))) return 'every record must be an object';
  return null;
}

// Per-record check: returns the reason a record is dropped, or null to keep it.
function recordProblem(r, knownIds, requireKnownId) {
  if (typeof r.resource_id !== 'string' || !ID_FORMAT.test(r.resource_id)) return `resource_id ${JSON.stringify(r.resource_id)} is not a resource id`;
  if (!STATES.includes(r.status)) return `status ${JSON.stringify(r.status)} is not allowed`;
  if (r.email && !EMAIL.test(r.email)) return `email ${JSON.stringify(r.email)} is malformed`;
  if (requireKnownId && !knownIds.has(r.resource_id)) return 'resource_id appears in no text evidence';
  return null;
}

// Resource ids that appear in participant-visible text files (labels in sample_output.csv excluded).
// Used to mark vision-only records; with VISION_REQUIRE_KNOWN_ID=1 it becomes a filter (ADR-015).
let knownIdsCache = null;
export function knownResourceIds() {
  if (knownIdsCache) return knownIdsCache;
  const re = new RegExp(RESOURCE_ID_RE.source, 'g');
  knownIdsCache = new Set();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(csv|json|sql|log|txt)$/.test(e.name) && e.name !== 'sample_output.csv') {
        for (const m of fs.readFileSync(p, 'utf8').match(re) ?? []) knownIdsCache.add(m);
      }
    }
  };
  walk(DATASET_DIR);
  return knownIdsCache;
}

// Identity confirmation (ADR-017). A vision record is "confirmed" when its email or user_id EXACTLY
// matches a known person (current or historical identifiers). An email one edit away from a known email
// is a likely misread character: it is not accepted, it is removed from the record's links so it cannot
// tie data to the wrong subject, and it is flagged for review.
let identityIndex = null;
function identities() {
  if (identityIndex) return identityIndex;
  const emails = new Set();
  const userIds = new Set();
  for (const u of loadIdentities().values()) {
    userIds.add(u.user_id);
    emails.add(normalizeId(u.email));
    for (const c of u.changes) if (c.field_name === 'email') { emails.add(normalizeId(c.old_value)); emails.add(normalizeId(c.new_value)); }
  }
  identityIndex = { emails, userIds };
  return identityIndex;
}

function withinOneEdit(a, b) {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

export function confirmIdentity(r) {
  const { emails, userIds } = identities();
  const email = r.email ? normalizeId(r.email) : null;
  const byEmail = email && emails.has(email);
  const byUserId = r.user_id && userIds.has(r.user_id);
  const nearMatch = email && !byEmail ? [...emails].find((known) => known && withinOneEdit(email, known)) ?? null : null;
  const status = byEmail || byUserId ? 'confirmed' : nearMatch ? 'near_match' : 'unconfirmed';
  return { status, via: byEmail ? 'email' : byUserId ? 'user_id' : null, nearMatch };
}

export function createVisualReader(llm) {
  return async function readVisual(file) {
    const bytes = fs.readFileSync(file.absPath);
    const attachment = { mimeType: MIME[file.ext], base64: bytes.toString('base64'), sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    const out = await llm.json({
      task: 'visual_extract', provider: 'gemini', prompt: PROMPT,
      input: `Artifact ${file.relPath}, captured ${file.capturedAt}.`, attachments: [attachment], validate: validateShape, retry: VISION_RETRY,
    });
    const knownIds = knownResourceIds();
    const requireKnownId = process.env.VISION_REQUIRE_KNOWN_ID === '1';
    const observations = [];
    const dropped = [];
    const visionOnly = [];
    const identity = { confirmed: [], nearMatch: [], unconfirmed: [] };
    for (const r of out.records) {
      const problem = recordProblem(r, knownIds, requireKnownId);
      if (problem) { dropped.push({ resource_id: r.resource_id ?? null, reason: problem }); continue; }
      if (!knownIds.has(r.resource_id)) visionOnly.push(r.resource_id);
      const idCheck = confirmIdentity(r);
      if (idCheck.status === 'confirmed') identity.confirmed.push(r.resource_id);
      else if (idCheck.status === 'near_match') identity.nearMatch.push({ resource_id: r.resource_id, read: r.email, known: idCheck.nearMatch });
      else identity.unconfirmed.push(r.resource_id);
      // A near-miss email is never used as a link.
      const email = idCheck.status === 'near_match' ? null : r.email;
      // "Identifiable" only has meaning for records policy keeps after anonymizing or redacting them;
      // for any other record it just means the record exists.
      const status = r.status === 'IDENTIFIABLE' && !KEEPS_IDENTITY_STATE.test(r.resource_id) ? 'PRESENT' : r.status;
      const obs = observe(
        { resource_id: r.resource_id, record_type: r.record_type ?? undefined, user_id: r.user_id, email, phone: r.phone, full_name: r.name, retention_until: r.retain_until },
        { fileId: file.fileId, at: file.capturedAt, state: status, category: r.record_type ?? null, source: 'vision' },
      );
      if (obs) observations.push(obs);
    }
    const total = out.records.length;
    const vision = { proposed: total, kept: observations.length, dropped, visionOnly, identity, majorityRejected: total > 0 && dropped.length / total > 0.5 };
    return { observations, coverage: [...new Set(observations.map((o) => o.system))], vision };
  };
}

// Used when no model is available: the file is reported as partial instead of inventing content.
export async function readVisualUnavailable() {
  return { observations: [], coverage: [], note: 'vision model unavailable' };
}
