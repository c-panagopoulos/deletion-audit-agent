// Scripted adapter for tests: answers from FAKE_LLM_RESPONSES (JSON array consumed in order).
// Lets the pipeline, retry and fallback paths be exercised without a live model or API key.
let script = null;

export const fakeAdapter = {
  model: () => 'fake-scripted',
  available: () => true,
  async complete() {
    script ??= JSON.parse(process.env.FAKE_LLM_RESPONSES ?? '[]');
    if (!script.length) throw new Error('fake adapter script exhausted');
    return { text: script.shift(), inputTokens: 0, outputTokens: 0 };
  },
};
