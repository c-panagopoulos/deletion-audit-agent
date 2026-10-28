// Investigator (ADR-003): find every resource that belongs to the subject and its state at audit_at.
//
// Time rules (ADR-009):
//   - known:    an observation whose own timestamp is at or before audit_at was true at audit time;
//               it is used for linking resources to the subject and for their state.
//   - citable:  additionally, its file was captured at or before audit_at; only these are cited.
// A log line written at 08:57 for a 09:00 audit, exported in a file captured days later, is known but
// not citable: it can tell us the subject's account id, but cannot be the evidence_id of a finding.
// Claims vs evidence: system_activity is used to LINK resources (catalog links, "connector repopulated
// downstream resource X"), never to decide a resource's state; reported results are claims.
import { readCsv } from './lib/csv.js';
import { dataset } from './lib/paths.js';
import { normalizeId } from './identity.js';
import { RESOURCE_ID_RE, systemFor } from './ingest/record.js';

const RESOURCE_ID_RE_G = new RegExp(RESOURCE_ID_RE.source, 'g');
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const USER_RE = /\buser_\d+\b/g;

export function loadActivity() {
  return readCsv(dataset('system_activity.csv')).map((a) => ({
    ...a,
    detailIds: a.details.match(RESOURCE_ID_RE_G) ?? [],
    detailKeys: [...(a.details.match(EMAIL_RE) ?? []), ...(a.details.match(USER_RE) ?? [])].map(normalizeId),
  }));
}

export class EvidenceIndex {
  constructor(observations, files, activity) {
    this.files = files;
    this.activity = activity;
    this.byResource = new Map();
    this.byKey = new Map();
    for (const o of observations) {
      if (!this.byResource.has(o.resourceId)) this.byResource.set(o.resourceId, []);
      this.byResource.get(o.resourceId).push(o);
      for (const l of o.links) {
        const k = normalizeId(l);
        if (!k) continue;
        if (!this.byKey.has(k)) this.byKey.set(k, []);
        this.byKey.get(k).push(o);
      }
    }
  }

  known(obs, auditAt) {
    return obs.at <= auditAt;
  }

  citable(obs, auditAt) {
    return obs.fileCapturedAt <= auditAt && obs.at <= auditAt;
  }
}

// Collect the subject's resources. Returns Map<resourceId, { via: [...] }> describing why each is linked.
function linkResources(index, subject, auditAt) {
  const linked = new Map();
  const add = (rid, via) => {
    if (!linked.has(rid)) linked.set(rid, { via: [] });
    linked.get(rid).via.push(via);
  };

  // Experimental (off unless LINK_404_REQUIRES_PRIOR_DELETE=1, see ADR-021): a not-found account lookup
  // links the account to the subject only if that account had already been submitted for deletion
  // when the lookup ran; otherwise the 404 only says the email does not belong to that account.
  const strict404 = process.env.LINK_404_REQUIRES_PRIOR_DELETE === '1';
  const deletedBefore = (rid, at) => index.activity.some((a) => a.resource_id === rid && a.event_type === 'DELETE_RECORD' && a.event_time < at);
  for (const key of subject.keys) {
    for (const o of index.byKey.get(key) ?? []) {
      if (!index.known(o, auditAt)) continue;
      if (strict404 && o.state === 'ABSENT' && o.resourceId.startsWith('account_') && !deletedBefore(o.resourceId, o.at)) continue;
      add(o.resourceId, { type: 'evidence', fileId: o.fileId, key, at: o.at });
    }
  }
  for (const a of index.activity) {
    if (a.event_time > auditAt) continue;
    // Catalog/attachment links name the resource together with the subject's identifiers.
    if (a.detailKeys.some((k) => subject.keys.has(k))) {
      for (const rid of new Set([a.resource_id, ...a.detailIds])) add(rid, { type: 'activity_link', activityId: a.activity_id });
    }
  }
  // Search documents keep the account they were built from.
  for (const rid of [...linked.keys()]) {
    for (const o of index.byResource.get(rid) ?? []) {
      if (index.known(o, auditAt) && o.attrs.source_resource_id && subjectOwns(subject, o)) {
        add(o.attrs.source_resource_id, { type: 'source_resource', fileId: o.fileId });
      }
    }
  }
  // A process that repopulated one of the subject's resources is a recreation path for that subject.
  for (const a of index.activity) {
    if (a.event_time > auditAt || !/repopulated downstream resource/.test(a.details)) continue;
    if (a.detailIds.some((rid) => linked.has(rid))) add(a.resource_id, { type: 'recreates', activityId: a.activity_id, target: a.detailIds[0] });
  }
  return linked;
}

function subjectOwns(subject, obs) {
  return obs.links.some((l) => subject.keys.has(normalizeId(l)));
}

// Latest known observation decides the state at audit_at. Same-timestamp ties keep the one that
// reveals more (a record seen with exposed identifiers beats one seen without).
// The cited evidence is the latest citable observation showing that same state, if any.
function stateAt(index, resourceId, auditAt) {
  const obs = (index.byResource.get(resourceId) ?? []).filter((o) => index.known(o, auditAt));
  if (!obs.length) return null;
  obs.sort((a, b) => a.at.localeCompare(b.at) || a.pii.length - b.pii.length);
  const latest = obs[obs.length - 1];
  const citable = obs.filter((o) => index.citable(o, auditAt) && o.state === latest.state).pop();
  let fileId = citable?.fileId ?? '';
  let citedBy = citable ? 'observation' : null;
  if (!citable && latest.state === 'ABSENT' && latest.system === 'account_service') {
    const omission = omissionAfterDeletion(index, resourceId, obs, auditAt);
    if (omission) { fileId = omission.fileId; citedBy = 'omission'; }
  }
  return { latest: { ...latest, fileId, citedBy }, history: obs };
}

// ADR-018: an account known to be ABSENT only from a file exported after audit_at may cite a SQL
// snapshot as absence by omission (as a sample's official answer does), but
// only if that snapshot was captured AFTER the deletion, at or before audit_at, and covers
// account_service. The deletion time is the latest of the last PRESENT observation and the last
// DELETE_RECORD activity for the account; with neither, the first known ABSENT observation is used.
function omissionAfterDeletion(index, resourceId, obs, auditAt) {
  const lastPresent = obs.filter((o) => o.state !== 'ABSENT').map((o) => o.at).sort().pop();
  const lastDelete = index.activity
    .filter((a) => a.resource_id === resourceId && a.event_type === 'DELETE_RECORD' && a.event_time <= auditAt)
    .map((a) => a.event_time).sort().pop();
  const firstAbsent = obs.filter((o) => o.state === 'ABSENT').map((o) => o.at).sort()[0];
  const deletedAt = [lastPresent, lastDelete].filter(Boolean).sort().pop() ?? firstAbsent;
  if (!deletedAt) return null;
  const holders = new Set((index.byResource.get(resourceId) ?? []).map((o) => o.fileId));
  return index.files
    .filter((f) => f.ext === '.sql' && f.capturedAt > deletedAt && f.capturedAt <= auditAt
      && (f.coverage ?? []).includes('account_service') && !holders.has(f.fileId))
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))
    .pop() ?? null;
}

// A subject has one primary profile. When lookups name several account ids (e.g. an old readback
// that probed a different id with the same email), keep the one supported by the most recent evidence.
function keepPrimaryAccount(linked) {
  const accounts = [...linked.entries()].filter(([rid]) => rid.startsWith('account_'));
  if (accounts.length < 2) return;
  const lastSeen = ([, l]) => l.via.map((v) => v.at ?? '').sort().pop() ?? '';
  accounts.sort((a, b) => lastSeen(a).localeCompare(lastSeen(b)));
  for (const [rid] of accounts.slice(0, -1)) linked.delete(rid);
}

// For resources linked only through activity (no observation at all), fall back to the most recent
// full snapshot of that resource's system that does not contain it: absence by omission.
function absenceByOmission(index, resourceId, system, auditAt) {
  const candidates = index.files
    .filter((f) => f.capturedAt <= auditAt && f.ext === '.sql' && (f.coverage ?? []).includes(system))
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  const f = candidates[candidates.length - 1];
  if (!f) return null;
  return { fileId: f.fileId, at: f.capturedAt, state: 'ABSENT', explicit: false, resourceId, system, pii: [], links: [], attrs: {}, source: 'omission' };
}

export function investigate(index, subject, auditAt) {
  const linked = linkResources(index, subject, auditAt);
  keepPrimaryAccount(linked);
  const resources = [];
  for (const [resourceId, link] of linked) {
    const st = stateAt(index, resourceId, auditAt);
    let latest = st?.latest ?? null;
    const system = latest?.system ?? null;
    if (!latest) {
      const sys = (index.byResource.get(resourceId)?.[0]?.system) ?? systemFor(resourceId);
      latest = absenceByOmission(index, resourceId, sys, auditAt);
      if (!latest) continue;
    }
    resources.push({ resourceId, system: latest.system ?? system, latest, history: st?.history ?? [], link });
  }
  return { resources, linked };
}
