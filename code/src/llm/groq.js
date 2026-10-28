// Groq adapter (OpenAI-compatible chat completions). Model is configurable via GROQ_MODEL.
const URL = 'https://api.groq.com/openai/v1/chat/completions';

const LEGACY_SETTINGS = { temperature: 0, reasoning_effort: 'low' };

export const groqAdapter = {
  model: () => process.env.GROQ_MODEL ?? 'openai/gpt-oss-120b',
  // Only reasoning_effort is configurable (GROQ_REASONING_EFFORT, ADR-030); the default stays 'low' and
  // any other value enters the cache key. Temperature stays 0.
  settings: () => ({ ...LEGACY_SETTINGS, reasoning_effort: process.env.GROQ_REASONING_EFFORT ?? LEGACY_SETTINGS.reasoning_effort }),
  legacySettings: () => LEGACY_SETTINGS,
  available: () => Boolean(process.env.GROQ_API_KEY),

  async complete({ prompt, input, feedback }) {
    const messages = [
      { role: 'system', content: prompt },
      { role: 'user', content: input },
    ];
    if (feedback) messages.push({ role: 'user', content: feedback });
    const res = await fetch(URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      // Classification needs little reasoning; low effort cuts billed reasoning tokens.
      body: JSON.stringify({ model: this.model(), messages, ...this.settings(), response_format: { type: 'json_object' } }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const retryAfter = res.headers.get('retry-after');
      throw Object.assign(new Error(`groq HTTP ${res.status}${retryAfter ? ` retry-after=${retryAfter}s` : ''}: ${(await res.text()).slice(0, 300)}`), { provider: 'groq' });
    }
    const body = await res.json();
    return {
      text: body.choices?.[0]?.message?.content ?? '',
      inputTokens: body.usage?.prompt_tokens,
      outputTokens: body.usage?.completion_tokens, // includes reasoning tokens
      reasoningTokens: body.usage?.completion_tokens_details?.reasoning_tokens ?? null,
    };
  },
};
