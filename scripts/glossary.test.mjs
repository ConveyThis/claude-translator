/**
 * Glossary contract tests. No network, no key, no model.
 *
 * The case that motivated the feature is the first one: a user asked whether the tool
 * can tell Apple (the company) from apple (the fruit). Before this module it could not
 * — the do-not-translate list was matched against the whole trimmed unit and pasted
 * into one prompt line with no case guidance.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'os';
import { mkdtempSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';

import {
  loadGlossary, containsTerm, termsForBatch, glossaryPrompt,
  checkCompliance, glossaryFingerprint,
} from './glossary.mjs';

const load = (entries) => loadGlossary(entries, '/nowhere', resolve);
const term = (entry) => load([entry]).terms[0];

// ── The Apple problem ────────────────────────────────────────────────────────

test('a case-sensitive brand matches the company but not the fruit', () => {
  const apple = term({ source: 'Apple', rule: 'keep' });
  assert.equal(apple.matchCase, true, 'rule "keep" must default to case-sensitive');

  assert.ok(containsTerm('Apple announced a new device', apple));
  assert.ok(!containsTerm('I ate an apple for lunch', apple));
});

test('a brand does not match inside a longer word', () => {
  const apple = term({ source: 'Apple', rule: 'keep' });
  assert.ok(!containsTerm('Applesauce is on sale', apple));
  assert.ok(!containsTerm('The Appleton office', apple));
});

test('a case-insensitive term still respects word boundaries', () => {
  const t = term({ source: 'apple', rule: 'keep', matchCase: false });
  assert.ok(containsTerm('An apple a day', t));
  assert.ok(containsTerm('Apple pie recipe', t), 'case-insensitive should match either case');
  assert.ok(!containsTerm('pineapple juice', t), 'must not match inside pineapple');
});

test('sentence-initial and punctuation-adjacent terms match', () => {
  const acme = term({ source: 'Acme', rule: 'keep' });
  assert.ok(containsTerm('Acme is great', acme), 'start of string');
  assert.ok(containsTerm('We love Acme.', acme), 'followed by a period');
  assert.ok(containsTerm('(Acme)', acme), 'wrapped in parentheses');
  assert.ok(containsTerm('Acme', acme), 'the whole string');
});

// ── Term base ────────────────────────────────────────────────────────────────

test('longer terms sort before shorter ones so the specific name wins', () => {
  const { terms } = load([
    { source: 'Acme', rule: 'keep' },
    { source: 'Acme Cloud Inc', rule: 'keep' },
  ]);
  assert.equal(terms[0].source, 'Acme Cloud Inc');
});

test('per-locale targets pin the wording', () => {
  const t = term({ source: 'Dashboard', rule: 'translate', targets: { es: 'Panel de control', de: 'Dashboard' } });
  assert.equal(t.targets.es, 'Panel de control');
  assert.equal(t.matchCase, false, 'rule "translate" defaults to case-insensitive');
});

test('a "translate" term with no targets is dropped, with a reported reason', () => {
  const { terms, problems } = load([{ source: 'Widget', rule: 'translate' }]);
  assert.equal(terms.length, 0);
  assert.match(problems[0], /no targets/);
});

test('malformed rows are skipped, not fatal', () => {
  const { terms, problems } = load([
    { source: 'Acme', rule: 'keep' },
    { source: '', rule: 'keep' },
    { rule: 'keep' },
    { source: 'Bad', rule: 'nonsense' },
    'not an object',
  ]);
  assert.equal(terms.length, 1, 'the one good row survives');
  assert.equal(problems.length, 4);
});

// ── Batch subsetting (the cost control) ──────────────────────────────────────

test('only terms present in the batch are selected', () => {
  const { terms } = load([
    { source: 'Dashboard', rule: 'translate', targets: { es: 'Panel de control' } },
    { source: 'Workspace', rule: 'translate', targets: { es: 'Espacio de trabajo' } },
    { source: 'Apple', rule: 'keep' },
  ]);
  const picked = termsForBatch(terms, ['Open the Dashboard to begin'], 'es');
  assert.deepEqual(picked.map((t) => t.source), ['Dashboard']);
});

test('a term with no target for THIS locale is not sent to the model', () => {
  const { terms } = load([
    { source: 'Dashboard', rule: 'translate', targets: { es: 'Panel de control' } },
  ]);
  assert.equal(termsForBatch(terms, ['Open the Dashboard'], 'es').length, 1);
  assert.equal(termsForBatch(terms, ['Open the Dashboard'], 'fr').length, 0,
    'fr has no pinned target, so the term constrains nothing and must not bloat the prompt');
});

test('an empty glossary produces no prompt text at all', () => {
  assert.equal(glossaryPrompt([], 'es'), '');
  assert.deepEqual(termsForBatch([], ['anything'], 'es'), []);
});

test('the prompt names the rule and the capitalisation constraint', () => {
  const { terms } = load([
    { source: 'Apple', rule: 'keep' },
    { source: 'Dashboard', rule: 'translate', targets: { es: 'Panel de control' } },
  ]);
  const picked = termsForBatch(terms, ['Apple built the Dashboard'], 'es');
  const prompt = glossaryPrompt(picked, 'es');
  assert.match(prompt, /leave exactly as "Apple"/);
  assert.match(prompt, /this capitalisation only/);
  assert.match(prompt, /always render as "Panel de control"/);
});

// ── Compliance ───────────────────────────────────────────────────────────────

test('a dropped brand is a violation; a surviving one is not', () => {
  const { terms } = load([{ source: 'Acme', rule: 'keep' }]);
  assert.equal(checkCompliance('Acme is fast', 'Acme es rápido', terms, 'es').length, 0);

  const bad = checkCompliance('Acme is fast', 'Cumbre es rápido', terms, 'es');
  assert.equal(bad.length, 1);
  assert.equal(bad[0].rule, 'keep');
  assert.equal(bad[0].expected, 'Acme');
});

test('compliance tolerates inflection around a pinned term', () => {
  const { terms } = load([
    { source: 'Dashboard', rule: 'translate', targets: { es: 'Panel de control' } },
  ]);
  const ok = checkCompliance('Open the Dashboard', 'Abre el Panel de control', terms, 'es');
  assert.equal(ok.length, 0);

  const alsoOk = checkCompliance('Dashboard settings', 'Ajustes del panel de control', terms, 'es');
  assert.equal(alsoOk.length, 0, 'case and surrounding words must not trigger a false positive');

  const bad = checkCompliance('Open the Dashboard', 'Abre el Tablero', terms, 'es');
  assert.equal(bad.length, 1);
});

test('a term absent from the source is never checked against the target', () => {
  const { terms } = load([{ source: 'Acme', rule: 'keep' }]);
  assert.equal(checkCompliance('Nothing to see', 'Nada que ver', terms, 'es').length, 0);
});

// ── Fingerprint ──────────────────────────────────────────────────────────────

test('the fingerprint is order-independent but content-sensitive', () => {
  const a = load([
    { source: 'Acme', rule: 'keep' },
    { source: 'Dashboard', rule: 'translate', targets: { es: 'Panel' } },
  ]).terms;
  const b = load([
    { source: 'Dashboard', rule: 'translate', targets: { es: 'Panel' } },
    { source: 'Acme', rule: 'keep' },
  ]).terms;
  assert.equal(glossaryFingerprint(a), glossaryFingerprint(b), 'reordering must not invalidate a memory');

  const c = load([
    { source: 'Acme', rule: 'keep' },
    { source: 'Dashboard', rule: 'translate', targets: { es: 'Panel de control' } },
  ]).terms;
  assert.notEqual(glossaryFingerprint(a), glossaryFingerprint(c), 'a changed target must invalidate');
});

// ── Loading from a file ──────────────────────────────────────────────────────

test('a glossary loads from a JSON file path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ct-glossary-'));
  const file = join(dir, 'glossary.json');
  writeFileSync(file, JSON.stringify([{ source: 'Acme', rule: 'keep' }]));

  const { terms } = loadGlossary('glossary.json', dir, resolve);
  assert.equal(terms.length, 1);
  assert.equal(terms[0].source, 'Acme');
});
