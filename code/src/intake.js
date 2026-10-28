// Intake (ADR-003, ADR-010): does request_text authorize deletion?
// Primary path: the LLM classifier (prompts/intent.md). The rule classifier below always runs as an
// independent cross-check and is the fallback when the model is unavailable or returns invalid output
// (ADR-002). Disagreements are recorded in the case trace for review.
// The rules look for deletion intent in the request languages seen in the data and then for signals
// that the person wants the account kept, because non-deletion requests often contain deletion words in
// a negated form ("Do not close the account", "correct it without removing any of my records").
import fs from 'node:fs';
import path from 'node:path';
import { CODE_DIR } from './lib/paths.js';

const INTENT_PROMPT = fs.readFileSync(path.join(CODE_DIR, 'prompts', 'intent.md'), 'utf8');
const INTENTS = ['DELETION', 'NOT_DELETION'];

// Guard rules (ADR-022). These are generic properties of untrusted input, not knowledge of any case:
// - an oversized request is not sent to the model (it is classified by the rules and flagged; the
//   text itself is never altered or rejected). Observed maximum in the data: 252 characters.
// - text that looks like instructions to a model is flagged in the trace. Flag only: the decision is
//   still made by the classifier, and the flag never changes the result.
export const MAX_REQUEST_CHARS = Number(process.env.INTAKE_MAX_CHARS ?? 2000);
const INJECTION_SIGNALS = [
  ['override_instructions', /\b(ignore|disregard|forget)\b.{0,30}\b(previous|prior|above|all|your)\b.{0,20}\b(instructions?|rules|prompt)/i],
  ['role_marker', /(^|\n)\s*(system|assistant|developer)\s*:/i],
  ['classifier_directive', /\b(classify|label|mark|treat|answer|reply|respond)\b.{0,40}\b(DELETION|NOT_DELETION|COMPLETE|INCOMPLETE|NOT_APPLICABLE)\b/],
  ['tag_escape', /<\/?\s*(request|system|instructions?)\b|<\|[a-z_]+\|>/i],
  ['json_payload', /\{\s*"(intent|records|deletion_status)"\s*:/i],
];

export function injectionSignals(text) {
  return INJECTION_SIGNALS.filter(([, re]) => re.test(text)).map(([name]) => name);
}

function validateIntent(out) {
  if (!INTENTS.includes(out?.intent)) return `"intent" must be one of ${INTENTS.join(', ')}`;
  if (typeof out.reason !== 'string' || out.reason.length > 300) return '"reason" must be a short string';
  return null;
}

export function createIntentClassifier(llm, { provider = 'groq' } = {}) {
  return async function classifyIntent(text) {
    const rules = classifyIntentRules(text);
    const signals = injectionSignals(text);
    const flags = signals.length ? { injectionSignals: signals } : {};
    if (text.length > MAX_REQUEST_CHARS) {
      return { ...rules, ...flags, method: 'rules_oversized', fallbackReason: `request_text is ${text.length} chars (limit ${MAX_REQUEST_CHARS}); not sent to the model` };
    }
    try {
      const out = await llm.json({
        task: 'intent', provider, prompt: INTENT_PROMPT, input: `<request>\n${text}\n</request>`, validate: validateIntent,
      });
      return { intent: out.intent, method: 'llm', reason: out.reason, rules: rules.intent, agreement: out.intent === rules.intent, ...flags };
    } catch (err) {
      if (err.dailyQuota) throw err; // never hide a quota stop behind the rules fallback (ADR-027)
      return { ...rules, ...flags, method: 'rules_fallback', fallbackReason: err.message };
    }
  };
}

const DELETION_TERMS = [
  /\bdelet\w*/i, /\beras\w*/i,
  /\bremov\w*\b.{0,40}\b(account|profile|records?|data|details|cop(y|ies)|results?|traces?|file)\b/i,
  /\b(account|profile|data)\b.{0,60}\b(removed|deleted|erased|gone)\b/i,
  /\bclos\w* .{0,20}account\b/i,
  /suppression|supprimer/i, /eliminaci[oó]n|eliminar|borrar/i, /exclus[aã]o|excluir/i,
  /löschen|löschung/i, /cancellazione|eliminare/i, /삭제/, /削除/, /удал/i,
];

const KEEP_SIGNALS = [
  /\b(do not|don't|never) (close|delete|remove|erase|deactivate)\b/i,
  /\bwithout (removing|deleting|closing|erasing)\b/i,
  /\b(keep|leave) (the|my) (account|profile)\b/i,
  /\bleave (the|my) .{0,40}(active|in place)\b/i,
  /\bcontinue using\b/i,
  /\b(marketing|promotional)\b.{0,40}\bonly\b|\bonly\b.{0,40}\b(marketing|promotional)\b/i,
  /\bstop (the )?(promotional|marketing)\b/i,
  /\b(copy|download|export) (of )?(my|the)\b.{0,40}\b(data|information|invoices?)\b/i,
  /\bwhat personal (information|data) you hold\b/i,
  /\b(change|update|correct|replace) (the|my) .{0,30}(email|number|name|surname|address)\b/i,
  /\bmisspelled\b/i, /\breset(ting)? the login\b/i,
];

export function classifyIntentRules(text) {
  const keep = KEEP_SIGNALS.find((re) => re.test(text));
  if (keep) return { intent: 'NOT_DELETION', method: 'rules', reason: `keep-account signal: ${keep.source}` };
  const del = DELETION_TERMS.find((re) => re.test(text));
  if (del) return { intent: 'DELETION', method: 'rules', reason: `deletion term: ${del.source}` };
  return { intent: 'NOT_DELETION', method: 'rules', reason: 'no deletion intent found' };
}
