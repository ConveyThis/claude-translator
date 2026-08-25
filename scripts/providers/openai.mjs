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
 *
 * ── Sampling is not universal either ─────────────────────────────────────────
 * The same "one adapter, many servers" problem applies to `temperature`. Reasoning
 * models reject it outright — GPT-5.x answers a `temperature: 0.2` with
 * 400 "Unsupported value: 'temperature' … Only the default (1) is supported" — and
 * they take a reasoning budget instead. That is handled twice over, deliberately:
 * proactively by the model table below, and reactively by `unsupportedParam()`, so a
 * model family nobody has heard of yet degrades instead of failing the whole run.
 */

const API = 'https://api.openai.com/v1';

export const id = 'openai';
export const label = 'OpenAI-compatible';
export const defaultModel = 'gpt-5.6-luna';
export const envKeys = ['OPENAI_API_KEY', 'OPENAI_COMPATIBLE_API_KEY'];

/** Local servers accept any key, but some reject a missing Authorization header. */
export const keyOptional = true;

/**
 * Model families that reject sampling parameters and take `reasoning_effort` instead.
 *
 * Kept to a prefix match on purpose. This adapter points at dozens of servers, and a
 * local model whose id merely CONTAINS "gpt-5" must not be caught by it — `qwen2.5:14b`
 * and friends still get `temperature` exactly as before.
 */
const REASONING = [/^gpt-5/i, /^o[1-9](-|$)/i];
const isReasoning = (model) => REASONING.some((re) => re.test(String(model)));

/**
 * Parameters this adapter is willing to drop and retry without. Nothing else is
 * droppable, so a 400 that happens to contain the word "unsupported" can never make the
 * pipeline silently discard something load-bearing. `response_format` is deliberately
 * absent — it has its own ladder in `unsupportedJsonMode()`.
 */
const DROPPABLE = ['temperature', 'reasoning_effort', 'top_p'];

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

export function request({ model, system, items, temperature, key, baseUrl, jsonMode, drop }) {
  const dropped = drop ?? new Set();
  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify(items) },
    ],
  };

  // Reasoning models: no sampling parameter, and no reasoning budget either. Bulk
  // segment translation is a low-reasoning task, so paying for thinking tokens on every
  // batch of forty is pure waste — the same call `anthropic.mjs` makes when it pins the
  // thinking tiers to `effort: 'low'`. `temperature` is omitted rather than sent as 1 so
  // the server applies its own default; sending a value it merely tolerates would be a
  // claim we have no reason to make.
  if (isReasoning(model)) {
    if (!dropped.has('reasoning_effort')) body.reasoning_effort = 'none';
  } else if (!dropped.has('temperature')) {
    body.temperature = temperature;
  }

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
  if (unsupportedParam(status, errText)) return false; // a sampling complaint, not a schema one
  return /response_format|json_schema|json_object|not supported|unrecognized|unknown.*field/i.test(errText);
}

/**
 * A rejection caused by ONE request parameter rather than by the request being wrong.
 * Returns the parameter's name so `translate.mjs` can retry without it, or null.
 *
 * The bar is deliberately high: the error must read like a capability complaint AND name
 * a parameter this adapter actually sends and is willing to lose. Anything looser would
 * let a genuine 400 ("model not found") be mistaken for a recoverable one, and the run
 * would keep quietly degrading its own request instead of telling the user.
 *
 * Real messages this must catch:
 *   400 "Unsupported value: 'temperature' does not support 0.2 with this model.
 *        Only the default (1) is supported."
 *   400 "Unrecognized request argument supplied: reasoning_effort"
 */
export function unsupportedParam(status, errText) {
  if (status !== 400 && status !== 422) return null;
  const text = String(errText ?? '');
  if (!/unsupported|unrecognized|unknown|not supported|does not support/i.test(text)) return null;
  return DROPPABLE.find((p) => new RegExp(`\\b${p}\\b`).test(text)) ?? null;
}

/** Unknown by design: this adapter points at dozens of providers, and local ones are free. */
export function pricing() {
  return null;
}
