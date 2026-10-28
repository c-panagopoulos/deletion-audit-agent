// Builds evaluation/usage_report.md from the usage records of a run (ADR-005).
// Prices are estimates in USD per million tokens and can be overridden with PRICE_<PROVIDER>_IN/_OUT;
// check them against the providers' current pricing pages before relying on the cost figures.
const DEFAULT_PRICES = {
  groq: { in: 0.15, out: 0.60 },
  gemini: { in: 0.30, out: 2.50 },
  fake: { in: 0, out: 0 },
};

function price(provider) {
  const p = DEFAULT_PRICES[provider] ?? { in: 0, out: 0 };
  const env = (k) => process.env[`PRICE_${provider.toUpperCase()}_${k}`];
  return { in: Number(env('IN') ?? p.in), out: Number(env('OUT') ?? p.out) };
}

// Token optimizations measured before the final run and deliberately not applied (ADR-028).
const OPTIMIZATIONS = `## Token optimizations considered (not applied)

Measured on 401 cached intent calls before the final run: about 410 input and 40 output tokens per call;
a regression of input tokens on request length gives a fixed part of about 390 tokens (95% of input):
about 290 for the system prompt and about 100 for the model's chat template.

| Candidate | Saving on intent tokens | Why not applied |
|---|---|---|
| Shorter system prompt (draft 709 vs 1,206 characters) | about 120 tokens per call, about -27%; about -5.6 min on a run limited by 8k tokens/min | It changes the component that makes the deletion decision just before the freeze; re-verifying it on all requests costs about 130k tokens, which shares the 200k/day provider limit with the final run. Money saved: about $0.01. |
| "max_tokens" cap on the answer | about 0% (average output 40, p95 45) | Output is already short; a cap only guards against runaway answers and risks truncated JSON. |
| Drop the "reason" field | about 3% (about 15 tokens) | Removes the explanation recorded in each case trace. |
`;

const fmt = (n) => (n === null ? 'unknown' : n.toLocaleString('en-US'));
const usd = (n) => `$${n.toFixed(6)}`;

// Where each task's answers came from in this run (ADR-029): fresh model calls or a cache, with the
// cache location and the time range in which the cached answers were produced.
function provenance(usage) {
  const byTask = new Map();
  for (const u of usage) {
    if (!byTask.has(u.task)) byTask.set(u.task, { fresh: 0, cached: 0, dirs: new Set(), from: null, to: null, model: u.model, provider: u.provider });
    const t = byTask.get(u.task);
    if (!u.cached) { t.fresh++; continue; }
    t.cached++;
    t.dirs.add(u.cacheDir);
    if (u.cachedAt) { t.from = !t.from || u.cachedAt < t.from ? u.cachedAt : t.from; t.to = !t.to || u.cachedAt > t.to ? u.cachedAt : t.to; }
  }
  const lines = ['## Provenance of model answers in this run', '', '| Task | Provider / model | Fresh API calls | Answers reused from cache | Cache location | Cached answers produced |', '|---|---|---|---|---|---|'];
  for (const [task, t] of byTask) {
    lines.push(`| ${task} | ${t.provider} / ${t.model} | ${t.fresh} | ${t.cached} | ${[...t.dirs].join(', ') || '-'} | ${t.from ? `${t.from.slice(0, 16)}Z to ${t.to.slice(0, 16)}Z` : '-'} |`);
  }
  return lines.join('\n');
}

export function usageReport(usage, { requests, title = 'Usage report', note = '' }) {
  const groups = new Map();
  // Cold-run tokens count each distinct answer once: identical requests in one run share a cache key,
  // so an empty-cache run pays for them once (e.g. 518 requests -> 375 distinct intent texts).
  const coldSeen = new Set();
  for (const u of usage) {
    const key = `${u.provider}|${u.model}`;
    if (!groups.has(key)) groups.set(key, { provider: u.provider, model: u.model, tasks: new Set(), calls: 0, cached: 0, retries: 0, in: 0, out: 0, reasoning: 0, coldIn: 0, coldOut: 0, unknown: 0 });
    const g = groups.get(key);
    g.tasks.add(u.task);
    if (u.inputTokens === null || u.outputTokens === null) g.unknown++;
    // cold-run tokens: what producing every distinct output costs from an empty cache
    const coldKey = u.key ?? `${u.provider}|${u.model}|${g.calls + g.cached}`;
    if (!coldSeen.has(coldKey)) {
      coldSeen.add(coldKey);
      g.coldIn += u.inputTokens ?? 0;
      g.coldOut += u.outputTokens ?? 0;
      g.coldCalls = (g.coldCalls ?? 0) + 1;
    }
    if (u.cached) { g.cached++; continue; }
    g.calls++;
    if (u.attempt > 1) g.retries++;
    g.in += u.inputTokens ?? 0;
    g.out += u.outputTokens ?? 0;
    g.reasoning += u.reasoningTokens ?? 0;
  }

  const rows = [...groups.values()].map((g) => {
    const p = price(g.provider);
    return { ...g, cost: (g.in * p.in + g.out * p.out) / 1e6, coldCost: (g.coldIn * p.in + g.coldOut * p.out) / 1e6, price: p };
  });
  const add = (t, r) => Object.fromEntries(Object.keys(t).map((k) => [k, t[k] + r[k]]));
  const total = rows.reduce(add, { calls: 0, cached: 0, in: 0, out: 0, cost: 0, coldIn: 0, coldOut: 0, coldCost: 0 });

  const lines = [
    `# ${title}`, '',
    note, '',
    `Requests processed: **${requests}**. Model calls are counted once per API request; cache hits (responses reused from an earlier run) cost nothing and are listed separately.`, '',
    provenance(usage), '',
    '## Per model', '',
    'Billed tokens are what this run sent to the provider. Cold-run tokens include the original cost of cached responses, i.e. the cost of reproducing this output from an empty cache.', '',
    'Output tokens include reasoning/thinking tokens (billed as output); the "of which reasoning" column shows that part.', '',
    '| Provider | Model | Tasks | API calls | Retries | Cache hits | Billed in | Billed out | of which reasoning | Billed cost | Cold-run in | Cold-run out | Cold-run cost | Price in/out (USD per 1M) |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.provider} | ${r.model} | ${[...r.tasks].join(', ')} | ${r.calls} | ${r.retries} | ${r.cached} | ${fmt(r.in)} | ${fmt(r.out)} | ${fmt(r.reasoning)} | ${usd(r.cost)} | ${fmt(r.coldIn)} | ${fmt(r.coldOut)} | ${usd(r.coldCost)} | ${r.price.in} / ${r.price.out} |`),
    '', '## Overall', '',
    '| Metric | This run (billed) | Cold run |', '|---|---|---|',
    `| Model calls | ${total.calls} | ${rows.reduce((t, r) => t + (r.coldCalls ?? 0), 0)} |`,
    `| Input tokens | ${fmt(total.in)} | ${fmt(total.coldIn)} |`,
    `| Output tokens | ${fmt(total.out)} | ${fmt(total.coldOut)} |`,
    `| Total tokens | ${fmt(total.in + total.out)} | ${fmt(total.coldIn + total.coldOut)} |`,
    `| Average tokens per request | ${requests ? fmt(Math.round((total.in + total.out) / requests)) : 'n/a'} | ${requests ? fmt(Math.round((total.coldIn + total.coldOut) / requests)) : 'n/a'} |`,
    `| Estimated total cost | ${usd(total.cost)} | ${usd(total.coldCost)} |`,
    `| Estimated cost per request | ${requests ? usd(total.cost / requests) : 'n/a'} | ${requests ? usd(total.coldCost / requests) : 'n/a'} |`,
    '',
    rows.some((r) => r.unknown) ? '> Some calls did not report token usage; they are counted as unknown, not as zero.' : '',
    '> Prices are estimates; override with `PRICE_<PROVIDER>_IN` / `PRICE_<PROVIDER>_OUT` (USD per 1M tokens).',
    '',
    OPTIMIZATIONS,
  ];
  return lines.join('\n');
}
