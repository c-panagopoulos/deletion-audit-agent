// Model layer (ADR-005): one interface, interchangeable provider adapters, on-disk response cache,
// and per-call usage accounting.
//
//   const llm = createLlm();
//   const out = await llm.json({ task: 'intent', provider: 'groq', prompt, input, validate, retry });
//
// - retry: transient-failure policy for this call ({ attempts, delaysMs, retryable }). It is NOT part
//   of the cache key, so changing timeouts or retries never invalidates stored results.
//
// - Cache key = hash(provider, model, prompt, input): reruns are free and deterministic, and evaluation
//   can run without API keys once the cache is warm.
// - validate(parsed) returns an error string or null. Invalid output gets ONE retry with the error fed
//   back; after that the call throws and the caller uses its deterministic fallback (ADR-002).
// - Usage the provider did not report is counted as unknown, never as zero.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CACHE_DIR } from '../lib/paths.js';
import { loadEnv } from '../lib/env.js';
import { groqAdapter } from './groq.js';
import { geminiAdapter } from './gemini.js';
import { fakeAdapter } from './fake.js';

loadEnv();

const ADAPTERS = { groq: groqAdapter, gemini: geminiAdapter, fake: fakeAdapter };

// Transient provider failures (timeouts, rate limits, overload) are retried with exponential backoff.
// This is separate from the single corrective retry for invalid output below.
const TRANSIENT = /timeout|aborted|HTTP (408|429|500|502|503|504)|ECONNRESET|fetch failed/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A provider's DAILY quota is exhausted (Gemini "...PerDay...", Groq "tokens/requests per day (TPD/RPD)").
// This is not a model failure: it must not fall back to rules or mark a file unreadable, because that
// would silently change results. It propagates to main.js, which stops without writing output.csv;
// everything already answered is in the cache, so the next run resumes from there (ADR-027).
export class DailyQuotaError extends Error {
  constructor(provider, message) { super(`${provider} daily quota exhausted: ${message}`); this.name = 'DailyQuotaError'; this.dailyQuota = true; }
}
const DAILY = /PerDay|per ?day|\((TPD|RPD)\)/i;

async function withBackoff(fn, { attempts = 6, baseMs = 3000, delaysMs = null, retryable = TRANSIENT } = {}) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      // A daily quota will not recover within a run: stop at once, no retries.
      if (DAILY.test(err.message)) throw Object.assign(new DailyQuotaError(err.provider ?? 'provider', err.message.slice(0, 200)), { attempts: i });
      if (i >= attempts || !retryable.test(err.message)) {
        err.attempts = i;
        throw err;
      }
      // Honour the provider's retry-after hint when it gives one; otherwise use the call's schedule.
      const hinted = Number(err.message.match(/retry-after=([\d.]+)s/)?.[1]);
      const planned = delaysMs ? delaysMs[Math.min(i - 1, delaysMs.length - 1)] : baseMs * 2 ** (i - 1);
      await sleep(hinted ? hinted * 1000 + 250 : planned);
    }
  }
}

export function createLlm({ offline = process.env.LLM_OFFLINE === '1' } = {}) {
  const usage = [];
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  // LLM_CACHE_DIR lets experiments use a separate cache without touching the main one.
  // Backup final run (ADR-029): LLM_TASK_CACHE_<TASK>=<dir> serves one task from another cache, and
  // LLM_READONLY_TASKS=<task,...> forbids model calls for those tasks (a cache miss stops the run).
  const cacheDir = process.env.LLM_CACHE_DIR ? path.resolve(process.env.LLM_CACHE_DIR) : CACHE_DIR;
  fs.mkdirSync(cacheDir, { recursive: true });
  const readOnly = new Set((process.env.LLM_READONLY_TASKS ?? '').split(',').filter(Boolean));
  const dirFor = (task) => {
    const override = process.env[`LLM_TASK_CACHE_${task.toUpperCase()}`];
    return override ? path.resolve(override) : cacheDir;
  };
  function cachePath(key, task) {
    return path.join(dirFor(task), `${key}.json`);
  }

  // Generation settings are part of the cache key (ADR-026), so an answer produced with one temperature
  // is never reused for another. Settings equal to those the existing cache was built with are left out
  // of the key, which keeps every existing entry valid.
  function settingsKey(adapter) {
    const now = adapter.settings?.() ?? {};
    const legacy = adapter.legacySettings?.() ?? {};
    const changed = Object.fromEntries(Object.entries(now).filter(([k, v]) => legacy[k] !== v));
    return Object.keys(changed).length ? [changed] : [];
  }

  async function json({ task, provider, prompt, input, attachments = [], validate = () => null, retry = {} }) {
    const adapter = ADAPTERS[provider];
    if (!adapter) throw new Error(`unknown provider ${provider}`);
    const model = adapter.model();
    const key = crypto.createHash('sha256')
      .update(JSON.stringify([provider, model, prompt, input, attachments.map((a) => a.sha256), ...settingsKey(adapter)]))
      .digest('hex').slice(0, 32);

    const file = cachePath(key, task);
    if (fs.existsSync(file)) {
      const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
      // Cache hits are free now, but keep the tokens the original call used so reports can state the
      // cost of a cold run honestly, and where the answer came from.
      usage.push({ task, provider, model, key, cached: true, cacheDir: path.relative(process.cwd(), path.dirname(file)) || '.', cachedAt: fs.statSync(file).mtime.toISOString(), inputTokens: cached.usage?.inputTokens ?? null, outputTokens: cached.usage?.outputTokens ?? null, reasoningTokens: cached.usage?.reasoningTokens ?? null });
      return cached.output;
    }
    if (readOnly.has(task)) {
      const err = new Error(`${task} answer missing from read-only cache ${dirFor(task)}; refusing to call ${provider} (backup run)`);
      err.dailyQuota = true; // same clean stop as a quota exhaustion: no fallback, no output (ADR-029)
      throw err;
    }
    if (offline || !adapter.available()) throw new Error(`${provider} unavailable (no API key or offline mode)`);

    let feedback = null;
    const spent = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
    for (let attempt = 1; attempt <= 2; attempt++) {
      const res = await withBackoff(() => adapter.complete({ prompt, input, attachments, feedback }), retry);
      usage.push({ task, provider, model, key, cached: false, attempt, inputTokens: res.inputTokens ?? null, outputTokens: res.outputTokens ?? null, reasoningTokens: res.reasoningTokens ?? null });
      spent.inputTokens += res.inputTokens ?? 0;
      spent.outputTokens += res.outputTokens ?? 0;
      spent.reasoningTokens += res.reasoningTokens ?? 0;
      let parsed;
      try {
        parsed = JSON.parse(res.text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
      } catch {
        feedback = 'Your previous reply was not valid JSON. Reply with JSON only.';
        continue;
      }
      const error = validate(parsed);
      if (!error) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ provider, model, task, settings: adapter.settings?.() ?? null, usage: spent, output: parsed }, null, 2));
        return parsed;
      }
      feedback = `Your previous reply was rejected: ${error}. Reply again with corrected JSON only.`;
    }
    throw new Error(`${provider} returned invalid output twice`);
  }

  return { json, usage };
}
