/**
 * Any OpenAI-compatible chat-completions endpoint.
 *
 * This is one adapter and a very long list of providers, because `/v1/chat/completions`
 * is the de-facto interface: OpenAI, Azure OpenAI, Groq, DeepSeek, Mistral, OpenRouter,
 * Together and Fireworks all speak it — and so do Ollama, LM Studio and vLLM, which is
 * how this pipeline runs on a local model at no marginal cost:
 *
 *   "provider": "openai",
 *   "baseUrl":  "http://localhost:11434/v1",
 *   "model":    "qwen2.5:14b"
 *
 * ── Structured output is a ladder, not a feature ─────────────────────────────
 * Support varies wildly across that list, so the adapter asks for the strongest form
 * the server advertises and degrades rather than failing:
 *
 *   1. `response_format: {type:'json_schema', …, strict:true}`  — OpenAI, Azure, vLLM
 *   2. `response_format: {type:'json_object'}`                  — most gateways, Ollama
 *   3. nothing but the prompt                                   — everything else
 *
 * `translate.mjs` already validates every unit's placeholders and retries what fails,
 * so a weaker guarantee here costs retries, not correctness. The rung is chosen by
 * config (`jsonMode`) and falls back automatically when the server rejects a request
 * for mentioning `response_format`.
 */

const API = 'https://api.openai.com/v1';

export const id = 'openai';
export const label = 'OpenAI-compatible';
export const defaultModel = 'gpt-4o-mini';
export const envKeys = ['OPENAI_API_KEY', 'OPENAI_COMPATIBLE_API_KEY'];

/** Local servers accept any key, but some reject a missing Authorization header. */
export const keyOptional = true;

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    translations: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'integer' }, text: { type: 'string' } },
        required: ['id', 'text'],
        additionalProperties: false,
      },
    },
  },
  required: ['translations'],
  additionalProperties: false,
};

export function request({ model, system, items, temperature, key, baseUrl, jsonMode }) {
  const body = {
    model,
    temperature,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify(items) },
    ],
  };

  const mode = jsonMode ?? 'schema';
  if (mode === 'schema') {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: 'translations', strict: true, schema: RESPONSE_SCHEMA },
    };
  } else if (mode === 'object') {
    body.response_format = { type: 'json_object' };
  }

  return {
    url: `${(baseUrl ?? API).replace(/\/$/, '')}/chat/completions`,
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      'content-type': 'application/json',
    },
    body,
  };
}

export function parse(data) {
  const choice = data?.choices?.[0];
  const usage = data?.usage ?? {};
  const norm = { inTok: usage.prompt_tokens ?? 0, outTok: usage.completion_tokens ?? 0 };

  const finish = choice?.finish_reason;
  if (finish === 'content_filter') {
    return { text: null, usage: norm, retryable: 'safety', detail: 'content_filter' };
  }

  const text = choice?.message?.content;
  if (!text) return { text: null, usage: norm, retryable: null, detail: finish };

  return {
    text,
    usage: norm,
    retryable: finish === 'length' ? 'truncated' : null,
    detail: finish,
  };
}

export const unwrap = (parsed) => parsed?.translations ?? parsed;

/**
 * A rejection caused by response_format rather than by the request being wrong.
 * Lets translate.mjs drop one rung of the ladder instead of failing the run — the
 * difference between "this server is older than I assumed" and "this is broken".
 */
export function unsupportedJsonMode(status, errText) {
  if (status !== 400 && status !== 404 && status !== 422) return false;
  return /response_format|json_schema|json_object|not supported|unrecognized|unknown.*field/i.test(errText);
}

/** Unknown by design: this adapter points at dozens of providers, and local ones are free. */
export function pricing() {
  return null;
}
