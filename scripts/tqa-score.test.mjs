/**
 * TQA scoring contract tests. No network, no key, no model.
 *
 * A published quality score is only worth what its arithmetic is worth, so the MQM
 * formula, the sampling determinism and the judge-failure handling are all pinned here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WEIGHT, rng, words, stratifiedSample, parseErrors, score } from './tqa-score.mjs';

const unit = (n, errors = []) => ({ words: n, errors });

// ── MQM arithmetic ───────────────────────────────────────────────────────────

test('a clean sample scores 100', () => {
  const r = score([unit(50), unit(50)]);
  assert.equal(r.mqm, 100);
  assert.equal(r.penalty, 0);
  assert.equal(r.unitsClean, 2);
});

test('severity weights are the conventional MQM values', () => {
  assert.deepEqual(WEIGHT, { minor: 1, major: 5, critical: 10 });
});

test('the score is penalty per 100 words', () => {
  // one major (5 points) over 100 words = 5 points per 100 words = 95.
  const r = score([unit(100, [{ category: 'accuracy/mistranslation', severity: 'major' }])]);
  assert.equal(r.mqm, 95);

  // the same error over 500 words is a fifth of the penalty density.
  const r2 = score([unit(500, [{ category: 'accuracy/mistranslation', severity: 'major' }])]);
  assert.equal(r2.mqm, 99);
});

test('a critical error costs ten times a minor one', () => {
  const minor = score([unit(100, [{ category: 'fluency/grammar', severity: 'minor' }])]);
  const critical = score([unit(100, [{ category: 'accuracy/mistranslation', severity: 'critical' }])]);
  assert.equal(100 - minor.mqm, 1);
  assert.equal(100 - critical.mqm, 10);
});

test('errors are counted by severity and category', () => {
  const r = score([
    unit(100, [
      { category: 'fluency/grammar', severity: 'minor' },
      { category: 'fluency/grammar', severity: 'major' },
    ]),
    unit(100, [{ category: 'terminology/glossary', severity: 'critical' }]),
  ]);
  assert.deepEqual(r.bySeverity, { minor: 1, major: 1, critical: 1 });
  assert.deepEqual(r.byCategory, { 'fluency/grammar': 2, 'terminology/glossary': 1 });
  assert.equal(r.unitsClean, 0);
});

test('an empty assessment scores 100 rather than dividing by zero', () => {
  const r = score([]);
  assert.equal(r.mqm, 100);
  assert.equal(r.totalWords, 0);
});

// ── Sampling ─────────────────────────────────────────────────────────────────

const pool = (n) => Array.from({ length: n }, (_, i) => ({ hash: `h${i}`, count: n - i }));

test('sampling is deterministic for a given seed', () => {
  const a = stratifiedSample(pool(300), 50, 42).map((u) => u.hash);
  const b = stratifiedSample(pool(300), 50, 42).map((u) => u.hash);
  assert.deepEqual(a, b, 'the same seed must reproduce the same sample');
});

test('a different seed gives a different sample', () => {
  const a = stratifiedSample(pool(300), 50, 1).map((u) => u.hash);
  const b = stratifiedSample(pool(300), 50, 2).map((u) => u.hash);
  assert.notDeepEqual(a, b);
});

test('a pool smaller than the sample is returned whole', () => {
  assert.equal(stratifiedSample(pool(10), 100, 1).length, 10);
});

test('the sample never exceeds the requested size', () => {
  assert.equal(stratifiedSample(pool(1000), 100, 1).length, 100);
});

test('frequent strings are over-represented, because visitors read them more', () => {
  // pool(300) has count descending, so the top third is the most-repeated third.
  const picked = stratifiedSample(pool(300), 90, 7);
  const fromTopThird = picked.filter((u) => Number(u.hash.slice(1)) < 100).length;
  assert.ok(fromTopThird > 30, `expected the top third to be over-sampled, got ${fromTopThird}/90`);
});

test('the PRNG is stable across runs', () => {
  const a = [rng(123)(), rng(123)(), rng(123)()];
  assert.equal(a[0], a[1]);
  assert.equal(a[1], a[2]);
});

// ── Word counting ────────────────────────────────────────────────────────────

test('word counting ignores surrounding whitespace', () => {
  assert.equal(words('  one two   three  '), 3);
  assert.equal(words(''), 0);
  assert.equal(words('single'), 1);
});

// ── Judge output parsing ─────────────────────────────────────────────────────

test('an empty error list parses as clean', () => {
  assert.deepEqual(parseErrors('[]'), []);
  assert.deepEqual(parseErrors('  '), []);
});

test('short and long field names both parse', () => {
  const short = parseErrors('[{"c":"fluency/grammar","s":"minor","n":"agreement"}]');
  assert.equal(short.length, 1);
  assert.equal(short[0].category, 'fluency/grammar');
  assert.equal(short[0].severity, 'minor');

  const long = parseErrors('[{"category":"fluency/grammar","severity":"major","note":"x"}]');
  assert.equal(long[0].severity, 'major');
});

test('an unknown severity is dropped rather than scored', () => {
  const r = parseErrors('[{"c":"fluency/grammar","s":"catastrophic"}]');
  assert.deepEqual(r, [], 'a severity with no weight cannot be scored, so it is not counted');
});

test('unreadable judge output is null, NOT an empty list', () => {
  // This distinction is load-bearing. Treating a failed judgement as "no errors found"
  // would inflate the score every time the judge failed — exactly backwards.
  assert.equal(parseErrors('not json'), null);
  assert.equal(parseErrors('{"not":"an array"}'), null);
  assert.equal(parseErrors(undefined), null);
  assert.equal(parseErrors(null), null);
});

test('severity casing from the model is normalised', () => {
  const r = parseErrors('[{"c":"fluency/grammar","s":"MAJOR"}]');
  assert.equal(r.length, 1);
  assert.equal(r[0].severity, 'major');
});
