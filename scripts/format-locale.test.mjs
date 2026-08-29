/**
 * Locale-formatting contract tests. No network, no key, no model.
 *
 * The "must not touch" block is the important half. Rewriting a version number, a time
 * or an IP address into a localised decimal is worse than doing nothing at all, and it
 * would ship silently — the markup would still be byte-identical and every other gate
 * would pass.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatText, intlLocale } from './format-locale.mjs';

const fmt = (text, locale, opts) => formatText(text, locale, opts).text;
/** Intl uses NBSP/narrow-NBSP; normalise so assertions stay readable. */
const norm = (s) => s.replace(/[  ]/g, ' ');

// ── Grouped numbers ──────────────────────────────────────────────────────────

test('grouped numbers take the target locale separators', () => {
  assert.equal(norm(fmt('We processed 1,234,567 files', 'de')), 'We processed 1.234.567 files');
  assert.equal(norm(fmt('We processed 1,234,567 files', 'fr')), 'We processed 1 234 567 files');
  assert.equal(norm(fmt('We processed 1,234,567 files', 'en')), 'We processed 1,234,567 files');
});

test('a grouped decimal keeps its value and its precision', () => {
  assert.equal(norm(fmt('1,234.50 units', 'de')), '1.234,50 units');
  assert.equal(norm(fmt('1,234.5 units', 'de')), '1.234,5 units');
});

test('an ungrouped number is left alone — there is no convention to apply', () => {
  assert.equal(fmt('We support 50 languages', 'de'), 'We support 50 languages');
  assert.equal(fmt('Founded in 2026', 'de'), 'Founded in 2026');
  assert.equal(fmt('Page 7', 'fr'), 'Page 7');
});

// ── Currency: formatted, never converted ─────────────────────────────────────

test('currency symbol placement follows the locale, value unchanged', () => {
  assert.equal(norm(fmt('$5', 'fr')), '5,00 $US');
  assert.equal(norm(fmt('$1,234.50', 'de')), '1.234,50 $');
  assert.match(norm(fmt('$5', 'en')), /^\$5\.00$/);
});

test('the numeric value of a price is never altered', () => {
  for (const locale of ['de', 'fr', 'ja', 'es', 'ar']) {
    const out = fmt('$49', locale);
    assert.ok(/49/.test(out), `${locale}: 49 must survive, got ${out}`);
    assert.ok(!/4[0-8](\D|$)/.test(out.replace(/49/g, '')), `${locale}: no other amount may appear`);
  }
});

test('the currency is held constant — no conversion, ever', () => {
  const out = norm(fmt('$100', 'de'));
  assert.ok(!out.includes('€'), `must not become euros, got ${out}`);
  assert.ok(out.includes('$'), `must stay dollars, got ${out}`);
});

test('a trailing ISO currency code is recognised', () => {
  assert.equal(norm(fmt('1,500 USD', 'de')), '1.500,00 $');
});

test('currency formatting can be switched off', () => {
  assert.equal(fmt('$1,234.50', 'de', { currency: 'off', numbers: false }), '$1,234.50');
});

// ── Percent ──────────────────────────────────────────────────────────────────

test('percent spacing follows the locale', () => {
  assert.equal(norm(fmt('Save 50%', 'fr')), 'Save 50 %');
  assert.equal(norm(fmt('Save 50%', 'en')), 'Save 50%');
  assert.equal(norm(fmt('Save 12.5%', 'de')), 'Save 12,5 %');
});

// ── Must not touch ───────────────────────────────────────────────────────────

test('semantic version numbers are left alone', () => {
  for (const s of ['Requires Node 20.5.1', 'Version 1.2.3 is out', 'v2.0 ships today']) {
    assert.equal(fmt(s, 'de'), s, s);
  }
});

test('times are left alone', () => {
  for (const s of ['Opens at 10:30', 'Between 9:00 and 17:45']) {
    assert.equal(fmt(s, 'de'), s, s);
  }
});

test('IP addresses are left alone', () => {
  assert.equal(fmt('Connect to 192.168.1.1 now', 'de'), 'Connect to 192.168.1.1 now');
});

test('ISO dates are left alone', () => {
  assert.equal(fmt('Released 2026-08-29', 'de'), 'Released 2026-08-29');
});

test('phone numbers are left alone', () => {
  for (const s of ['Call +1-800-555-0199', 'Call 1-800-555-0199']) {
    assert.equal(fmt(s, 'de'), s, s);
  }
});

test('fractions and ratios are left alone', () => {
  assert.equal(fmt('A 1/2 scale model', 'de'), 'A 1/2 scale model');
});

test('file sizes without grouping are left alone', () => {
  assert.equal(fmt('Upload up to 10 MB', 'de'), 'Upload up to 10 MB');
  assert.equal(fmt('1 GB of storage', 'fr'), '1 GB of storage');
});

test('placeholders are never entered or altered', () => {
  const src = 'Save <0>1,234</0> files and <1/> more';
  const out = fmt(src, 'de');
  assert.ok(out.includes('<0>'), 'opening placeholder survives');
  assert.ok(out.includes('</0>'), 'closing placeholder survives');
  assert.ok(out.includes('<1/>'), 'self-closing placeholder survives');
  assert.equal((out.match(/<\/?\d+\/?>/g) ?? []).length, 3);
});

// ── Reporting ────────────────────────────────────────────────────────────────

test('monetary amounts are reported for human review', () => {
  const { money } = formatText('Plans from $9 to $99 per month', 'de');
  assert.equal(money.length, 2);
  assert.deepEqual(money.map((m) => m.value), [9, 99]);
  assert.ok(money.every((m) => m.currency === 'USD'));
});

test('changes are itemised so a build can show its work', () => {
  const { changes } = formatText('1,000 items at 50%', 'de');
  assert.ok(changes.some((c) => c.kind === 'number'));
  assert.ok(changes.some((c) => c.kind === 'percent'));
});

test('a string with nothing to format is returned byte-identical', () => {
  const src = 'Translate your website into any language';
  const { text, changes, money } = formatText(src, 'de');
  assert.equal(text, src);
  assert.equal(changes.length, 0);
  assert.equal(money.length, 0);
});

test('empty and non-string input is survivable', () => {
  assert.equal(formatText('', 'de').text, '');
  assert.equal(formatText(null, 'de').text, null);
  assert.equal(formatText(undefined, 'de').text, undefined);
});

// ── Locale tag ───────────────────────────────────────────────────────────────

test('Intl gets the hreflang tag, not the URL path code', () => {
  assert.equal(intlLocale({ hreflang: 'pt-BR', pathCode: 'pt-br' }), 'pt-BR');
  assert.equal(intlLocale({ hreflang: 'zh-Hant', pathCode: 'zh-tw' }), 'zh-Hant');
  assert.equal(intlLocale({ pathCode: 'es' }), 'es');
});

test('an unknown locale degrades to leaving text alone, never to a crash', () => {
  const out = formatText('1,234 items', 'not-a-locale');
  assert.equal(typeof out.text, 'string');
});

test('Spanish does not group four-digit numbers, but German does — this is not a bug', () => {
  // CLDR minimumGroupingDigits=2 for es. "1234,50" is correct Spanish and "1.234,50" is
  // correct German for the same amount. This looked like a lost separator during
  // development and is the exact thing a future reader will try to "fix".
  assert.equal(norm(fmt('$1,234.50', 'es')), '1234,50 US$');
  assert.equal(norm(fmt('$1,234.50', 'de')), '1.234,50 $');
  assert.equal(norm(fmt('12,345 items', 'es')), '12.345 items', 'five digits DO group in Spanish');
});
