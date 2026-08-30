/**
 * Element-context contract tests. No network, no key, no model.
 *
 * The prompt has always said "button labels stay short" while the model had no way to
 * know what a button was. These tests pin the mapping that finally makes that actionable,
 * and — more importantly — pin the cases where the tool must say NOTHING rather than
 * guess.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { roleOf, rolePrompt } from './roles.mjs';

const unit = (el, kind = 'block') => ({ kind, el });

// ── Controls ─────────────────────────────────────────────────────────────────

test('a button is a button', () => {
  assert.equal(roleOf(unit('button')), 'button');
});

test('a standalone <a> is treated as a call to action', () => {
  // <a> is INLINE in extract.mjs, so a link inside a sentence is absorbed into the
  // surrounding block as a placeholder and never recorded on its own. An <a> that DOES
  // surface as its own unit is a standalone link — a CTA or a nav item.
  assert.equal(roleOf(unit('a')), 'button');
});

test('headings at every level map to one role', () => {
  for (const h of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
    assert.equal(roleOf(unit(h)), 'heading', h);
  }
});

test('form and table furniture get their own roles', () => {
  assert.equal(roleOf(unit('label')), 'form label');
  assert.equal(roleOf(unit('legend')), 'form label');
  assert.equal(roleOf(unit('summary')), 'expander label');
  assert.equal(roleOf(unit('th')), 'table header');
  assert.equal(roleOf(unit('figcaption')), 'caption');
  assert.equal(roleOf(unit('option')), 'menu option');
  assert.equal(roleOf(unit('title')), 'page title');
});

// ── Prose says nothing ───────────────────────────────────────────────────────

test('ordinary prose returns null so the field is omitted entirely', () => {
  for (const el of ['p', 'div', 'span', 'li', 'td', 'blockquote', 'section']) {
    assert.equal(roleOf(unit(el)), null, el);
  }
});

test('an unknown element is prose, not a guess', () => {
  assert.equal(roleOf(unit('marquee')), null);
  assert.equal(roleOf(unit('my-web-component')), null);
});

// ── The collision case ───────────────────────────────────────────────────────

test('a cleared element yields no hint at all', () => {
  // extract.mjs sets el to null when the same string appears as both a button and a
  // paragraph. Saying nothing is correct: a confident wrong answer is worse than none.
  assert.equal(roleOf(unit(null)), null);
  assert.equal(roleOf({ kind: 'block' }), null, 'a missing el behaves like a cleared one');
});

// ── Attributes ───────────────────────────────────────────────────────────────

test('attribute roles come from the attribute, not the element', () => {
  assert.equal(roleOf({ kind: 'attr:alt', el: 'img' }), 'image alt text');
  assert.equal(roleOf({ kind: 'attr:placeholder', el: 'input' }), 'input placeholder');
  assert.equal(roleOf({ kind: 'attr:aria-label', el: 'button' }), 'accessible label');
  assert.equal(roleOf({ kind: 'attr:title', el: 'abbr' }), 'tooltip');
});

test('an unmapped attribute is silent rather than mislabelled', () => {
  assert.equal(roleOf({ kind: 'attr:data-thing', el: 'div' }), null);
});

// ── Meta tags ────────────────────────────────────────────────────────────────

test('meta tags are distinguished by key, which kind alone cannot express', () => {
  // Every meta tag arrives as kind "attr:content"; the key travels in el.
  assert.equal(roleOf({ kind: 'attr:content', el: 'meta:description' }), 'meta description');
  assert.equal(roleOf({ kind: 'attr:content', el: 'meta:og:title' }), 'social share title');
  assert.equal(roleOf({ kind: 'attr:content', el: 'meta:og:description' }), 'social share description');
  assert.equal(roleOf({ kind: 'attr:content', el: 'meta:og:image:alt' }), 'image alt text');
});

test('an unrecognised meta key still says "not body copy"', () => {
  assert.equal(roleOf({ kind: 'attr:content', el: 'meta:custom:thing' }), 'page metadata');
});

// ── JSON-LD ──────────────────────────────────────────────────────────────────

test('structured data is labelled even though it has no element', () => {
  assert.equal(roleOf({ kind: 'jsonld', el: null }), 'structured data');
});

// ── Defensive ────────────────────────────────────────────────────────────────

test('junk input never throws', () => {
  for (const junk of [null, undefined, 'string', 42, []]) {
    assert.doesNotThrow(() => roleOf(junk));
  }
  assert.equal(roleOf(null), null);
});

// ── The prompt block ─────────────────────────────────────────────────────────

test('a batch of pure prose produces no prompt text and costs no tokens', () => {
  assert.equal(rolePrompt([]), '');
  assert.equal(rolePrompt([null, null, undefined]), '');
});

test('only the roles present in the batch are described', () => {
  const p = rolePrompt(['button', 'heading']);
  assert.match(p, /- button:/);
  assert.match(p, /- heading:/);
  assert.ok(!/image alt text/.test(p), 'roles absent from the batch must not be described');
});

test('duplicates collapse, so forty buttons describe the role once', () => {
  const p = rolePrompt(Array(40).fill('button'));
  assert.equal((p.match(/- button:/g) ?? []).length, 1);
});

test('the button advice does not demand the imperative', () => {
  // Languages differ: German UI prefers a verbal noun, French the infinitive. Ordering a
  // literal imperative everywhere is precisely the defect this feature exists to avoid.
  const p = rolePrompt(['button']);
  assert.match(p, /not the imperative/i);
  assert.match(p, /fixed-width/);
});

test('the prompt tells the model el is metadata, not text to translate', () => {
  const p = rolePrompt(['button']);
  assert.match(p, /must not be translated or echoed/);
});
