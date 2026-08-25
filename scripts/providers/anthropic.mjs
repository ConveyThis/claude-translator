/**
 * Anthropic Claude — the default provider.
 *
 * ── Structured output ────────────────────────────────────────────────────────
 * `output_config.format` with a JSON schema. Two constraints shape the schema:
 * every object needs `additionalProperties: false`, and the documented form takes an
 * object at the root — so the units are wrapped in `{ "translations": [...] }` and
 * unwrapped here. (Assistant prefill, the old way of forcing a JSON array, returns a
 * 400 on current models. It is not an option.)
 *
 * ── Why the capability table exists ──────────────────────────────────────────
 * Claude models do not take the same parameters, and guessing wrong is not a silent
 * no-op — it either errors or spends money:
 *
 *   claude-haiku-4-5   `output_config.effort` is REJECTED. Thinking is off unless
 *                      explicitly enabled. Send neither. This is the default model
 *                      because bulk segment translation is a low-reasoning task and
 *                      Haiku is the only tier priced for it.
 *   opus-5 / sonnet-5  Adaptive thinking; on Opus 5 it is ON BY DEFAULT. Left alone,
 *   opus-4-8 / fable-5 a large translation run would silently pay for reasoning it
 *                      does not need, so these get `effort: 'low'`.
 *
 * Low effort is used rather than `thinking: {type:'disabled'}` because disabling has
 * known failure modes on Opus 5 — it can write a tool call into visible text and leak
 * thinking tags.
 */

const API = 'https://api.anthropic.com/v1';
const VERSION_HEADER = '2023-06-01';

export const id = 'anthropic';
export const label = 'Anthropic Claude';
export const defaultModel = 'claude-haiku-4-5';
export const envKeys = ['ANTHROPIC_API_KEY'];

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

/** Models that accept output_config.effort. Haiku 4.5 rejects it outright. */
const ACCEPTS_EFFORT = [/^claude-opus-/, /^claude-sonnet-5/, /^claude-fable-/, /^claude-mythos-/];
const acceptsEffort = (model) => ACCEPTS_EFFORT.some((re) => re.test(model));

export function request({ model, system, items, temperature, key, baseUrl }) {
  const body = {
    model,
    max_tokens: 16000,
    system,
    messages: [{ role: 'user', content: JSON.stringify(items) }],
    output_config: { format: { type: 'json_schema', schema: RESPONSE_SCHEMA } },
  };

  // Keep the reasoning budget off the bill for a task that does not need it.
  if (acceptsEffort(model)) body.output_config.effort = 'low';
  else body.temperature = temperature; // Haiku-class models still take sampling params

  return {
    url: `${(baseUrl ?? API).replace(/\/$/, '')}/messages`,
    headers: {
      'x-api-key': key,
      'anthropic-version': VERSION_HEADER,
      'content-type': 'application/json',
    },
    body,
  };
}

export function parse(data) {
  const usage = data?.usage ?? {};
  const norm = { inTok: usage.input_tokens ?? 0, outTok: usage.output_tokens ?? 0 };

  // A safety decline arrives as HTTP 200 with stop_reason "refusal" — the analogue of
  // Gemini's blockReason, and handled the same way: split the batch so the blast radius
  // is the offending unit rather than all forty.
  if (data?.stop_reason === 'refusal') {
    return {
      text: null,
      usage: norm,
      retryable: 'safety',
      detail: data?.stop_details?.category ?? 'refusal',
    };
  }

  const text = (data?.content ?? []).find((b) => b?.type === 'text')?.text;
  if (!text) return { text: null, usage: norm, retryable: null, detail: data?.stop_reason };

  return {
    text,
    usage: norm,
    retryable: data?.stop_reason === 'max_tokens' ? 'truncated' : null,
    detail: data?.stop_reason,
  };
}

/** The schema wraps the array in an object; the pipeline wants the array. */
export const unwrap = (parsed) => parsed?.translations ?? parsed;

/** USD per million tokens [input, output]. Checked 2026-08-25. */
export function pricing(model) {
  if (model.startsWith('claude-haiku-4-5')) return [1, 5];
  if (model.startsWith('claude-sonnet-5')) return [3, 15];
  if (model.startsWith('claude-opus-')) return [5, 25];
  if (model.startsWith('claude-fable-') || model.startsWith('claude-mythos-')) return [10, 50];
  return null;
}
