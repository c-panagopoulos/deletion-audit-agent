// Gemini adapter (generateContent), used for visual evidence. Model is configurable via GEMINI_MODEL.
// Attachments are sent inline as base64 with their MIME type (PNG screenshots, PDF documents).
// Calls are spaced by GEMINI_MIN_INTERVAL_MS (default 13 s, under the free tier's per-minute limit):
// on the free tier rejected requests still count against the daily quota, so avoiding 429s matters
// more than retrying them.
let nextSlot = 0;
async function waitForSlot() {
  const gap = Number(process.env.GEMINI_MIN_INTERVAL_MS ?? 13_000);
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + gap;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

// Generation settings that affect the answer. `settings()` feeds the cache key (ADR-026).
const LEGACY_SETTINGS = { temperature: 0 };

export const geminiAdapter = {
  model: () => process.env.GEMINI_MODEL ?? 'gemini-3.8-flash',
  // Temperature 1.0 is the vendor's strong recommendation for Gemini 3 (ADR-025/026). The main cache was
  // built at 0, so offline rebuilds from it need GEMINI_TEMPERATURE=0.
  settings: () => ({ temperature: Number(process.env.GEMINI_TEMPERATURE ?? 1.0) }),
  legacySettings: () => LEGACY_SETTINGS,
  available: () => Boolean(process.env.GEMINI_API_KEY),

  async complete({ prompt, input, attachments = [], feedback }) {
    await waitForSlot();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model()}:generateContent`;
    const parts = [{ text: input }, ...attachments.map((a) => ({ inline_data: { mime_type: a.mimeType, data: a.base64 } }))];
    if (feedback) parts.push({ text: feedback });
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: prompt }] },
        contents: [{ role: 'user', parts }],
        generationConfig: { ...this.settings(), responseMimeType: 'application/json' },
      }),
      // 120 s per attempt (GEMINI_TIMEOUT_MS): a diagnostic call took 82 s, too close to 90 s (ADR-013).
      signal: AbortSignal.timeout(Number(process.env.GEMINI_TIMEOUT_MS ?? 120_000)),
    });
    if (!res.ok) {
      // Surface which quota was hit and the server's retry delay, so the caller can tell a
      // per-minute limit (wait and retry) from a per-day limit (fail fast).
      const text = await res.text();
      let detail = text.slice(0, 200);
      try {
        const err = JSON.parse(text).error;
        const quota = (err.details ?? []).flatMap((d) => d.violations ?? []).map((v) => v.quotaId).join(',');
        const delay = (err.details ?? []).find((d) => d.retryDelay)?.retryDelay;
        detail = `${err.message?.slice(0, 120)}${quota ? ` quota=${quota}` : ''}${delay ? ` retry-after=${parseFloat(delay)}s` : ''}`;
      } catch { /* non-JSON error body */ }
      throw Object.assign(new Error(`gemini HTTP ${res.status}: ${detail}`), { provider: 'gemini' });
    }
    const body = await res.json();
    return {
      text: body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '',
      inputTokens: body.usageMetadata?.promptTokenCount,
      // Thinking tokens are billed as output but reported separately (thoughtsTokenCount); count both.
      outputTokens: body.usageMetadata?.candidatesTokenCount === undefined ? undefined
        : body.usageMetadata.candidatesTokenCount + (body.usageMetadata.thoughtsTokenCount ?? 0),
      reasoningTokens: body.usageMetadata?.thoughtsTokenCount ?? 0,
    };
  },
};
