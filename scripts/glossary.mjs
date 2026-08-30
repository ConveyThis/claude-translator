/**
 * Glossary — terminology consistency and brand protection.
 *
 * Two questions this answers that `doNotTranslate` could not:
 *
 *   1. "Dashboard" must be "Panel de control" every time it appears, including inside
 *      sentences that are otherwise all different. The translation memory already keeps
 *      IDENTICAL strings consistent — it is keyed by the hash of the whole unit — but a
 *      term inside varying sentences lands in different units, different batches, and
 *      different stateless requests. Nothing compared them. A term base does.
 *
 *   2. "Apple" the company must survive; "apple" the fruit must be translated. The old
 *      list could not express the difference: it was a flat array of strings, matched
 *      against the WHOLE trimmed unit and pasted into one prompt line. Case sensitivity
 *      plus word boundaries is the whole answer, and it needs a per-term flag.
 *
 * ── Shape ────────────────────────────────────────────────────────────────────
 * Deliberately the same four fields the managed ConveyThis product stores per glossary
 * row (rule / source_text / translate_text / target_language), so a glossary can move
 * between the two without a translation layer.
 *
 *   { "source": "Dashboard", "rule": "translate",
 *     "targets": { "es": "Panel de control", "de": "Dashboard" } }
 *   { "source": "Apple",     "rule": "keep", "matchCase": true }
 *
 * `rule: "keep"` means leave it in the source language. `rule: "translate"` with
 * `targets` pins the wording per locale; a locale with no entry in `targets` is simply
 * not constrained, which is the honest default for a term nobody has decided yet.
 *
 * ── Why matching is conservative ─────────────────────────────────────────────
 * Every match here becomes either a prompt instruction or a compliance finding, and
 * `references/quality-review.md` is unambiguous that a heuristic which over-flags is
 * worse than no heuristic. So: word boundaries always, case-sensitivity opt-in per term,
 * and longest-term-first so "Acme Cloud Inc" wins over "Acme".
 */

import { readFileSync, existsSync } from 'fs';

/** Unicode-aware-ish word boundary: the char before/after a term must not be a letter,
 *  digit or underscore. Built by hand because JS \b is ASCII-only, so "Straße" would
 *  boundary wrongly against a following accented letter. */
const WORDISH = /[\p{L}\p{N}_]/u;

const isWordish = (ch) => ch !== undefined && WORDISH.test(ch);

/**
 * Normalise one raw entry. Returns null for anything unusable rather than throwing,
 * because a single malformed row must not take a 40-locale run down with it — the
 * caller reports the count of skipped rows instead.
 */
function normalise(entry, index, problems) {
  if (!entry || typeof entry !== 'object') {
    problems.push(`entry ${index}: not an object`);
    return null;
  }
  const source = typeof entry.source === 'string' ? entry.source.trim() : '';
  if (!source) {
    problems.push(`entry ${index}: missing "source"`);
    return null;
  }

  const rule = entry.rule ?? 'translate';
  if (rule !== 'keep' && rule !== 'translate') {
    problems.push(`entry ${index} ("${source}"): rule must be "keep" or "translate", got "${rule}"`);
    return null;
  }

  const targets = {};
  if (entry.targets && typeof entry.targets === 'object') {
    for (const [lang, value] of Object.entries(entry.targets)) {
      if (typeof value === 'string' && value.trim()) targets[lang] = value.trim();
    }
  }
  if (rule === 'translate' && Object.keys(targets).length === 0) {
    // Not an error: a term listed with no targets yet is still worth tracking for
    // consistency reporting. It just cannot constrain anything.
    problems.push(`entry ${index} ("${source}"): rule "translate" with no targets — ignored`);
    return null;
  }

  return {
    source,
    rule,
    targets,
    // Brands are the case-sensitive case, so "keep" defaults to case-sensitive and
    // "translate" does not. Either can be overridden explicitly.
    matchCase: entry.matchCase ?? rule === 'keep',
    note: typeof entry.note === 'string' ? entry.note : null,
  };
}

/**
 * Load and validate. Accepts an array (inline in i18n.config.json) or a path to a JSON
 * file — the same dual form `locales` already takes.
 */
export function loadGlossary(src, root, resolvePath) {
  if (!src) return { terms: [], problems: [] };

  let rawEntries = src;
  if (typeof src === 'string') {
    const p = resolvePath(root, src);
    if (!existsSync(p)) {
      console.error(`config.glossary points at ${p}, which does not exist`);
      process.exit(1);
    }
    try {
      rawEntries = JSON.parse(readFileSync(p, 'utf8'));
    } catch (err) {
      console.error(`config.glossary: ${p} is not valid JSON — ${err.message}`);
      process.exit(1);
    }
  }

  if (!Array.isArray(rawEntries)) {
    console.error('config.glossary must be an array, or a path to a JSON file containing one');
    process.exit(1);
  }

  const problems = [];
  const terms = rawEntries.map((e, i) => normalise(e, i, problems)).filter(Boolean);

  // Longest first, so "Acme Cloud Inc" is matched and consumed before "Acme".
  terms.sort((a, b) => b.source.length - a.source.length);
  return { terms, problems };
}

/**
 * Does `text` contain `term` as a whole word?
 *
 * Case-insensitive matching still requires the boundary check, so "apple" does not
 * match inside "pineapple" — the false positive that would otherwise make every
 * fruit-adjacent sentence look like a brand violation.
 */
export function containsTerm(text, term) {
  if (!text || !term?.source) return false;
  const haystack = term.matchCase ? text : text.toLowerCase();
  const needle = term.matchCase ? term.source : term.source.toLowerCase();

  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return false;
    const before = at === 0 ? undefined : haystack[at - 1];
    const after = haystack[at + needle.length];
    if (!isWordish(before) && !isWordish(after)) return true;
    from = at + 1;
  }
}

/**
 * The subset of the glossary that actually appears in this batch.
 *
 * This is the whole reason the feature is affordable. A 500-term glossary pasted into
 * the system prompt of every 40-unit batch would dominate token cost on a large site
 * and push the real instructions out of the model's attention. Sending only the terms
 * present in the batch keeps prompt growth proportional to what is actually at stake.
 */
export function termsForBatch(terms, texts, lang) {
  if (!terms.length) return [];
  return terms.filter((term) => {
    // A "translate" term with no target for THIS locale constrains nothing, so it would
    // only be noise in the prompt.
    if (term.rule === 'translate' && !term.targets[lang]) return false;
    return texts.some((t) => containsTerm(t, term));
  });
}

/** The prompt lines for a batch's terms. Empty string when there is nothing to say. */
export function glossaryPrompt(terms, lang) {
  if (!terms.length) return '';
  const lines = terms.map((t) => {
    const how = t.rule === 'keep'
      ? `leave exactly as "${t.source}"`
      : `always render as "${t.targets[lang]}"`;
    const cased = t.matchCase ? ' (this capitalisation only)' : '';
    return `   - "${t.source}"${cased}: ${how}${t.note ? ` — ${t.note}` : ''}`;
  });
  return [
    `TERMINOLOGY — these terms appear in this batch and are not free choices:`,
    ...lines,
    `   Match whole words only. A term that is part of a longer word is a different word.`,
    `   Inflect for grammar where the target language requires it, but keep the stem.`,
  ].join('\n');
}

/**
 * Compliance check for one translated unit.
 *
 * Returns a list of violations, each { source, expected, rule }. Deliberately NOT a
 * hard failure by default: target languages inflect ("Panel de control" →
 * "del Panel de control"), compound ("Dashboard-Ansicht"), and decline, so a strict
 * substring test would flag correct translations constantly. The caller decides.
 */
export function checkCompliance(sourceText, translatedText, terms, lang) {
  const violations = [];
  for (const term of terms) {
    if (!containsTerm(sourceText, term)) continue;

    if (term.rule === 'keep') {
      // "keep" is the strict one and can afford to be: the term is supposed to come
      // through byte-identical, so a plain case-sensitive substring test is right.
      if (!translatedText.includes(term.source)) {
        violations.push({ source: term.source, expected: term.source, rule: 'keep' });
      }
      continue;
    }

    const expected = term.targets[lang];
    if (!expected) continue;
    // Case-insensitive and boundary-free on purpose — this is the inflection-tolerant
    // side of the check. "Panel de control" inside "del Panel de control" passes.
    if (!translatedText.toLowerCase().includes(expected.toLowerCase())) {
      violations.push({ source: term.source, expected, rule: 'translate' });
    }
  }
  return violations;
}

/**
 * A stable fingerprint of the glossary, stored in the translation memory so a changed
 * glossary can invalidate exactly the units it affects rather than the whole locale.
 */
export function glossaryFingerprint(terms) {
  const canonical = terms
    .map((t) => `${t.rule}|${t.matchCase ? 'C' : 'i'}|${t.source}|${JSON.stringify(t.targets)}`)
    .sort()
    .join('\n');
  return canonical;
}
