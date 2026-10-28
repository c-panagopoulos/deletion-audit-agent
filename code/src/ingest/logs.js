// Log evidence. Six line syntaxes appear across the exports (key=value, JSON payload, RFC 5424
// syslog, [bracketed], pipe-separated, and cloud-runtime lines with a nested escaped `message`).
// Each line is normalized to { ts, service, trace, event, fields }, lines are grouped by trace id,
// and the identifier from the "*_started" line is joined to the resource/result on the
// "*_completed" / "*_scan" / "*_check" lines of the same trace.
import fs from 'node:fs';
import { observe } from './record.js';

const KV_RE = /([A-Za-z_][A-Za-z0-9_]*)=(?:"((?:[^"\\]|\\.)*)"|([^\s"|]+))/g;

function parseKv(text) {
  const out = {};
  for (const m of text.matchAll(KV_RE)) out[m[1]] = m[2] !== undefined ? m[2].replace(/\\"/g, '"') : m[3];
  return out;
}

export function parseLine(line) {
  const ts = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\s+(.*)$/);
  if (!ts) return null;
  const [, at, rest] = ts;
  let fields;
  let service;
  let trace;
  let event;

  if (rest.startsWith('{')) {
    try { fields = JSON.parse(rest); } catch { return null; }
  } else if (rest.startsWith('<')) {
    // <15>1 node-1 account_service tr-4973247 - - key="value" ...
    const m = rest.match(/^<\d+>\d+\s+\S+\s+(\S+)\s+(\S+)\s+\S+\s+\S+\s+(.*)$/);
    if (!m) return null;
    [, service, trace] = m;
    fields = parseKv(m[3]);
  } else if (rest.startsWith('[')) {
    // [LEVEL] [service] [trace] event: key="value" ...
    const m = rest.match(/^\[(\w+)\]\s+\[([^\]]+)\]\s+\[([^\]]+)\]\s+([a-z_]+):\s*(.*)$/);
    if (!m) return null;
    [, , service, trace, event] = m;
    fields = parseKv(m[5]);
  } else if (rest.startsWith('|') || /^\w+\s+\|/.test(rest)) {
    // | LEVEL | service | trace | event | key="value" ...
    const parts = rest.replace(/^\|\s*/, '').split(/\s+\|\s+/);
    [, service, trace, event] = parts;
    fields = parseKv(parts.slice(4).join(' | '));
  } else {
    fields = parseKv(rest);
    if (fields.message && fields.function) {
      // requestId=tr-0 level=INFO function=search_service message="resource_id=\"search_000\" ..."
      Object.assign(fields, parseKv(fields.message));
    }
  }

  service = service ?? fields.service ?? fields.function ?? fields.logger;
  trace = trace ?? fields.trace_id ?? fields.requestId ?? null;
  event = event ?? fields.event;
  return { at, service, trace, event, fields };
}

// Identifier-bearing fields on "*_started" lines.
const KEY_FIELDS = ['lookup_key', 'match_key', 'scan_key', 'subject_key', 'subject_ref', 'owner_key', 'correlation_key', 'lookup_value'];

const num = (v) => (v === undefined ? undefined : Number(v));

// Interpret one result-bearing log line. Returns { state?, category? } or null if the event says
// nothing about a resource's state. Unknown events are ignored rather than guessed.
function interpret(event, f) {
  switch (event) {
    case 'profile_lookup_completed':
      return { state: num(f.rows) === 0 || num(f.http_status) === 404 ? 'ABSENT' : 'PRESENT' };
    case 'index_query_completed':
      return { state: f.result === 'miss' || num(f.total_hits) === 0 ? 'ABSENT' : 'PRESENT' };
    case 'audit_record_read_completed':
      return { state: num(f.rows) === 0 ? 'ABSENT' : 'PRESENT' };
    case 'contact_query_completed':
    case 'contact_lookup_completed':
      return { state: num(f.rows) === 0 ? 'ABSENT' : 'PRESENT', category: event === 'contact_lookup_completed' ? 'SECONDARY_IDENTIFIER' : null };
    case 'export_metadata_read_completed':
    case 'export_download_check_completed':
      return { state: f.available === 'false' ? 'ABSENT' : 'PRESENT' };
    case 'attachment_pii_scan':
      return { state: 'PRESENT', category: 'SUPPORT_ATTACHMENT' };
    case 'message_pii_scan':
    case 'analytics_identity_scan':
      return { state: 'IDENTIFIABLE' };
    case 'message_read':
      return { state: /\[REDACTED\]/.test(f.message_text ?? '') ? 'REDACTED' : undefined };
    case 'retained_order_loaded':
    case 'deletion_marker_check':
      return { state: 'PRESENT' };
    case 'connector_config_read_completed':
    case 'connector_heartbeat':
    case 'connector_config_loaded':
    case 'restore_policy_read_completed':
    case 'restore_candidate_evaluated':
    case 'restore_authorization_completed':
    case 'analytics_profile_read_completed':
    case 'analytics_profile_read':
    case 'support_ticket_read_completed':
      return {}; // state derived from the record fields by the shared mapper
    case 'record_lookup':
      return {}; // carries record_type/result explicitly
    default:
      return null;
  }
}

export function readLog(file) {
  const lines = fs.readFileSync(file.absPath, 'utf8').split('\n').map(parseLine).filter(Boolean);
  const keysByTrace = new Map();
  for (const l of lines) {
    if (!l.trace) continue;
    for (const k of KEY_FIELDS) {
      if (l.fields[k] && l.fields[k] !== 'null') {
        if (!keysByTrace.has(l.trace)) keysByTrace.set(l.trace, new Set());
        keysByTrace.get(l.trace).add(l.fields[k]);
      }
    }
  }

  const observations = [];
  const covered = new Set();
  for (const l of lines) {
    if (!l.fields.resource_id) continue;
    const meaning = interpret(l.event, l.fields);
    if (!meaning) continue;
    const traceKeys = l.trace ? [...(keysByTrace.get(l.trace) ?? [])] : [];
    const record = { ...l.fields };
    // Join the trace's lookup keys so the completed line can be linked to the person searched for.
    traceKeys.forEach((k, i) => { record[`lookup_key${i ? `_${i}` : ''}`] = k; });
    const obs = observe(record, {
      fileId: file.fileId,
      at: l.at,
      // The owning system comes from the resource id; the logging service may be a replica or a collector.
      system: l.fields.system,
      state: meaning.state,
      category: meaning.category ?? undefined,
      source: `log:${l.event}`,
    });
    if (!obs) continue;
    for (const k of traceKeys) if (!obs.links.includes(k)) obs.links.push(k);
    observations.push(obs);
    covered.add(obs.system);
  }
  return { observations, coverage: [...covered] };
}
