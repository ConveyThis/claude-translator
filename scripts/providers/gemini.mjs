/**
 * Google Gemini.
 *
 * This adapter is a straight lift of the call that shipped in 1.0 and 1.1, and its
 * behaviour must stay identical: it is the only path with a ten-thousand-unit
 * production run behind it. In particular the response schema stays in Gemini's own
 * uppercase type dialect, and the units come back as a bare top-level array — the
 * other adapters wrap theirs in an object because their APIs require it, but changing
 * this one would be a change for symmetry's sake against proven code.
 */

const API = 'https://generativelanguage.googleapis.com/v1beta/models';

export const id = 'gemini';
export const label = 'Google Gemini';
export const defaultModel = 'gemini-2.5-flash-lite';
export const envKeys = ['GEMINI_API_KEY', 'GOOGLE_API_KEY'];

/** Gemini's schema dialect: uppercase type names, no additionalProperties. */
const RESPONSE_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: { id: { type: 'INTEGER' }, text: { type: 'STRING' } },
    required: ['id', 'text'],
  },
};

export function request({ model, system, items, temperature, key, baseUrl }) {
  return {
    url: `${(baseUrl ?? API).replace(/\/$/, '')}/${model}:generateContent`,
    headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
    body: {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: JSON.stringify(items) }] }],
      generationConfig: {
        temperature,
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
      },
    },
  };
}

export function parse(data) {
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  const usage = data?.usageMetadata ?? {};
  const norm = { inTok: usage.promptTokenCount ?? 0, outTok: usage.candidatesTokenCount ?? 0 };

  // The safety filter blocks the WHOLE request, so one string it dislikes takes the
  // other 39 in the batch with it. Reported as 'safety' so the caller can split.
  if (!text) {
    const blocked = data?.promptFeedback?.blockReason;
    if (blocked) return { text: null, usage: norm, retryable: 'safety', detail: blocked };
    return { text: null, usage: norm, retryable: null };
  }

  const finish = data?.candidates?.[0]?.finishReason;
  return {
    text,
    usage: norm,
    retryable: finish === 'MAX_TOKENS' ? 'truncated' : null,
    detail: finish,
  };
}

/** USD per million tokens [input, output]. Checked 2026-08-25. */
export function pricing(model) {
  if (model.includes('flash-lite')) return [0.1, 0.4];
  if (model.includes('flash')) return [0.3, 2.5];
  return null;
}
