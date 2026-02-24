/**
 * Minimal LLM adapter for summarization — uses same OpenAI-compatible endpoint as the agent.
 * Respects __ADK_MODEL_OVERRIDE (UI-selected model) when set, otherwise falls back to env vars.
 */
const defaultBaseUrl = (process.env.OPENAI_COMPATIBLE_BASE_URL ?? 'http://localhost:11434/v1').replace(/\/$/, '');
const defaultModel = process.env.OPENAI_COMPATIBLE_MODEL ?? process.env.ADK_COMPACTION_MODEL ?? 'glm-5:cloud';
const apiKey = process.env.OPENAI_API_KEY;

function getOverride() {
  return (typeof globalThis !== 'undefined' && globalThis.__ADK_MODEL_OVERRIDE) ?? null;
}

export const summarizerLlm = {
  get model() {
    const override = getOverride();
    return override?.model ?? defaultModel;
  },
  async *generateContentAsync(llmRequest, stream = false) {
    const override = getOverride();
    const baseUrl = override?.baseUrl ?? defaultBaseUrl;
    const model = override?.model ?? llmRequest?.model ?? defaultModel;

    const contents = llmRequest?.contents ?? [];
    const messages = contents.map((c) => ({
      role: c.role === 'model' ? 'assistant' : 'user',
      content: (c.parts ?? []).map((p) => p?.text ?? '').join('\n'),
    }));

    const url = `${baseUrl}/chat/completions`;
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages,
        stream: false,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      yield { errorCode: String(res.status), errorMessage: errText || res.statusText };
      return;
    }

    const json = await res.json();
    const choice = json?.choices?.[0];
    const content = choice?.message?.content ?? '';
    yield {
      content: { role: 'model', parts: [{ text: typeof content === 'string' ? content : String(content) }] },
      finishReason: choice?.finish_reason ?? 'STOP',
    };
  },
};
