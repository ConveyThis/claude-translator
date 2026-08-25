/**
 * Contract tests for the provider adapters.
 *
 *   node --test scripts/providers/
 *
 * These assert the two things an adapter is responsible for: the exact shape of the
 * request it builds, and what it makes of a response. They use no network and no key,
 * so they run in CI and on a contributor's laptop.
 *
 * What they do NOT prove is that a remote server accepts the request — only a live call
 * does that. What they DO catch is the class of bug that is otherwise invisible until
 * someone spends money: a misspelled header, a field nested one level too deep, a usage
 * counter read from the wrong key, a safety block that fails to trigger the batch split.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as gemini from './gemini.mjs';
import * as anthropic from './anthropic.mjs';
import * as openai from './openai.mjs';
import { inferProvider, extractJson } from './index.mjs';

const ITEMS = [{ id: 0, text: 'With <0>Acme</0>, hello.' }];
const ARGS = { system: 'You are a translator.', items: ITEMS, temperature: 0.2, key: 'test-key' };

// ── Gemini ───────────────────────────────────────────────────────────────────

test('gemini: request targets generateContent with the key header', () => {
  const r = gemini.request({ ...ARGS, model: 'gemini-2.5-flash-lite' });
  assert.equal(r.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent');
  assert.equal(r.headers['x-goog-api-key'], 'test-key');
  assert.equal(r.body.systemInstruction.parts[0].text, ARGS.system);
  assert.equal(r.body.contents[0].parts[0].text, JSON.stringify(ITEMS));
  assert.equal(r.body.generationConfig.responseMimeType, 'application/json');
  // Gemini's own dialect: uppercase types, bare array at the root.
  assert.equal(r.body.generationConfig.responseSchema.type, 'ARRAY');
});

test('gemini: parses text and normalises usage', () => {
  const out = gemini.parse({
    candidates: [{ content: { parts: [{ text: '[]' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 22 },
  });
  assert.equal(out.text, '[]');
  assert.deepEqual(out.usage, { inTok: 11, outTok: 22 });
  assert.equal(out.retryable, null);
});

test('gemini: a block reason asks for a split', () => {
  const out = gemini.parse({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } });
  assert.equal(out.retryable, 'safety');
  assert.equal(out.detail, 'PROHIBITED_CONTENT');
});

test('gemini: MAX_TOKENS asks for a split', () => {
  const out = gemini.parse({
    candidates: [{ content: { parts: [{ text: '[{' }] }, finishReason: 'MAX_TOKENS' }],
    usageMetadata: {},
  });
  assert.equal(out.retryable, 'truncated');
});

// ── Anthropic ────────────────────────────────────────────────────────────────

test('anthropic: request matches the Messages API contract', () => {
  const r = anthropic.request({ ...ARGS, model: 'claude-haiku-4-5' });
  assert.equal(r.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(r.headers['x-api-key'], 'test-key');
  assert.equal(r.headers['anthropic-version'], '2023-06-01');
  assert.equal(r.body.model, 'claude-haiku-4-5');
  assert.ok(r.body.max_tokens > 0, 'max_tokens is required by this API');
  assert.equal(r.body.system, ARGS.system);
  assert.equal(r.body.messages[0].role, 'user');
  assert.equal(r.body.output_config.format.type, 'json_schema');
  // Structured outputs need a root object and additionalProperties:false everywhere.
  assert.equal(r.body.output_config.format.schema.type, 'object');
  assert.equal(r.body.output_config.format.schema.additionalProperties, false);
});

test('anthropic: haiku gets no effort parameter (the API rejects it there)', () => {
  const r = anthropic.request({ ...ARGS, model: 'claude-haiku-4-5' });
  assert.equal(r.body.output_config.effort, undefined);
});

test('anthropic: thinking-capable tiers get low effort so a bulk run is not billed for reasoning', () => {
  for (const model of ['claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8']) {
    const r = anthropic.request({ ...ARGS, model });
    assert.equal(r.body.output_config.effort, 'low', `${model} should pin low effort`);
    assert.equal(r.body.temperature, undefined, `${model} does not accept sampling params`);
  }
});

test('anthropic: reads text and usage, and unwraps the schema envelope', () => {
  const out = anthropic.parse({
    content: [{ type: 'text', text: '{"translations":[]}' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 7, output_tokens: 9 },
  });
  assert.equal(out.text, '{"translations":[]}');
  assert.deepEqual(out.usage, { inTok: 7, outTok: 9 });
  assert.deepEqual(anthropic.unwrap({ translations: [1, 2] }), [1, 2]);
});

test('anthropic: a refusal asks for a split, like a Gemini block', () => {
  const out = anthropic.parse({
    stop_reason: 'refusal',
    stop_details: { type: 'refusal', category: 'cyber' },
    usage: { input_tokens: 1, output_tokens: 0 },
  });
  assert.equal(out.retryable, 'safety');
  assert.equal(out.detail, 'cyber');
});

test('anthropic: max_tokens asks for a split', () => {
  const out = anthropic.parse({
    content: [{ type: 'text', text: '{"translations":[{' }],
    stop_reason: 'max_tokens',
    usage: {},
  });
  assert.equal(out.retryable, 'truncated');
});

// ── OpenAI-compatible ────────────────────────────────────────────────────────

test('openai: default host and bearer auth', () => {
  const r = openai.request({ ...ARGS, model: 'gpt-4o-mini' });
  assert.equal(r.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(r.headers.authorization, 'Bearer test-key');
  assert.equal(r.body.messages[0].role, 'system');
  assert.equal(r.body.messages[1].content, JSON.stringify(ITEMS));
});

test('openai: a custom host is used verbatim — this is how local models work', () => {
  const r = openai.request({ ...ARGS, model: 'qwen2.5:14b', baseUrl: 'http://localhost:11434/v1' });
  assert.equal(r.url, 'http://localhost:11434/v1/chat/completions');
});

test('openai: a local server needs no key, and no Authorization header is sent', () => {
  const r = openai.request({ ...ARGS, key: null, baseUrl: 'http://localhost:11434/v1', model: 'x' });
  assert.equal(r.headers.authorization, undefined);
});

test('openai: the json-mode ladder produces three distinct requests', () => {
  const schema = openai.request({ ...ARGS, model: 'x', jsonMode: 'schema' });
  assert.equal(schema.body.response_format.type, 'json_schema');
  assert.equal(schema.body.response_format.json_schema.strict, true);

  const object = openai.request({ ...ARGS, model: 'x', jsonMode: 'object' });
  assert.equal(object.body.response_format.type, 'json_object');

  const none = openai.request({ ...ARGS, model: 'x', jsonMode: 'none' });
  assert.equal(none.body.response_format, undefined);
});

test('openai: parses choices and normalises usage', () => {
  const out = openai.parse({
    choices: [{ message: { content: '{"translations":[]}' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 4 },
  });
  assert.equal(out.text, '{"translations":[]}');
  assert.deepEqual(out.usage, { inTok: 3, outTok: 4 });
});

test('openai: length and content_filter map to the split reasons', () => {
  assert.equal(
    openai.parse({ choices: [{ message: { content: 'x' }, finish_reason: 'length' }] }).retryable,
    'truncated'
  );
  assert.equal(
    openai.parse({ choices: [{ finish_reason: 'content_filter' }] }).retryable,
    'safety'
  );
});

test('openai: a response_format rejection is recognised as a capability gap, not a failure', () => {
  assert.equal(openai.unsupportedJsonMode(400, "Unknown field 'response_format'"), true);
  assert.equal(openai.unsupportedJsonMode(400, 'json_schema is not supported'), true);
  // A genuine bad request must NOT be mistaken for one.
  assert.equal(openai.unsupportedJsonMode(400, 'model not found'), false);
  assert.equal(openai.unsupportedJsonMode(401, 'invalid api key'), false);
});

// ── Resolution and parsing helpers ───────────────────────────────────────────

test('provider is inferred from the model id, so pre-1.2 configs keep working', () => {
  assert.equal(inferProvider('gemini-2.5-flash-lite'), 'gemini');
  assert.equal(inferProvider('claude-haiku-4-5'), 'anthropic');
  assert.equal(inferProvider('gpt-4o-mini'), 'openai');
  assert.equal(inferProvider('qwen2.5:14b'), null, 'unknown ids must not guess');
  assert.equal(inferProvider(null), null);
});

test('extractJson survives what small and local models actually emit', () => {
  const want = [{ id: 0, text: 'hi' }];
  for (const raw of [
    '[{"id":0,"text":"hi"}]',
    '```json\n[{"id":0,"text":"hi"}]\n```',
    '```\n[{"id":0,"text":"hi"}]\n```',
    'Sure! Here you go:\n[{"id":0,"text":"hi"}]',
  ]) {
    assert.deepEqual(JSON.parse(extractJson(raw)), want, `failed on: ${raw.slice(0, 30)}`);
  }
});

test('every built-in adapter satisfies the interface', async () => {
  for (const mod of [gemini, anthropic, openai]) {
    assert.equal(typeof mod.id, 'string');
    assert.equal(typeof mod.defaultModel, 'string');
    assert.ok(Array.isArray(mod.envKeys));
    assert.equal(typeof mod.request, 'function');
    assert.equal(typeof mod.parse, 'function');
  }
});
