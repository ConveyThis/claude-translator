#!/usr/bin/env node
/**
 * i18n step 3.5 — quality review of a translation memory.
 *
 *   node scripts/i18n/review.mjs --lang es
 *   node scripts/i18n/review.mjs --lang es --purge     # drop flagged units, then re-translate
 *
 * Reads   i18n/source.json, i18n/tm/{lang}.json
 * Writes  i18n/tm/{lang}.review.json   (the flagged units, with reasons)
 *
 * Visual review catches what a human happens to look at. On the Spanish pricing page that
 * was "prueba una prueba de 7 días" — "try a try" — from "try a 7-day trial". One page,
 * spotted by chance. With 10,600 units × 55 locales nobody is reading 583,000 strings, so
 * the failure modes a machine CAN see are worth catching mechanically:
 *
 *   tautology       an adjacent word repeated — the "prueba una prueba" shape
 *   length-anomaly  translation wildly longer or shorter than the source
 *   untranslated    long string returned byte-identical (the model skipped it)
 *   latin-heavy     a non-Latin locale where the output is still mostly Latin script
 *   placeholder     placeholder multiset differs from the source (should be impossible —
 *                   translate.mjs validates — so a hit here means that guard regressed)
 *
 * --purge deletes the flagged hashes from the memory. Because translate.mjs is
 * incremental, re-running it then re-translates exactly those units and nothing else.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

import { SOURCE_FILE as SRC_FILE, TM_DIR, DNT } from './config.mjs';
import { hint, link } from './credit.mjs';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .join(' ')
    .split('--')
    .filter(Boolean)
    .map((s) => s.trim().split(/\s+/))
    .map(([k, ...v]) => [k, v.join(' ') || true])
);

const LANGS = String(args.lang ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const PURGE = Boolean(args.purge);
const TAUTOLOGY = Boolean(args.tautology);
if (LANGS.length === 0) {
  console.error('Usage: node scripts/i18n/review.mjs --lang es[,ru,...] [--purge]');
  process.exit(1);
}

/** Locales written in a non-Latin script — a Latin-heavy result there means it was not translated. */
const NON_LATIN = new Set([
  'ru',
  'uk',
  'bg',
  'sr',
  'mk',
  'be',
  'kk',
  'ky',
  'mn',
  'el',
  'he',
  'ar',
  'fa',
  'ur',
  'ps',
  'hi',
  'bn',
  'pa',
  'gu',
  'ta',
  'te',
  'kn',
  'ml',
  'mr',
  'ne',
  'si',
  'th',
  'lo',
  'my',
  'km',
  'ka',
  'hy',
  'am',
  'zh',
  'zh-tw',
  'ja',
  'ko',
  'yi',
  'sd',
  'ug',
]);

/** Scripts whose characters carry far more meaning than a Latin letter, so translations
 *  are legitimately much shorter than the English source. */
const COMPACT = new Set(['zh', 'zh-tw', 'ja', 'ko', 'th', 'lo', 'my', 'km']);

const PLACEHOLDER_RE = /<\/?\d+\/?>/g;
const placeholders = (s) => (s.match(PLACEHOLDER_RE) ?? []).slice().sort().join('');
const stripTags = (s) => s.replace(PLACEHOLDER_RE, ' ');

/**
 * A word repeated in IMMEDIATE succession once short connectors are dropped — the
 * "prueba una prueba" (= "try a try") shape produced from "try a 7-day trial".
 *
 * Two deliberate narrowings, both learned from a first version that flagged 622 of 10,597
 * Spanish units and was wrong nearly every time:
 *
 *  - only distance 1, never distance 2. "la traducción automática y la traducción humana"
 *    and "Traductor certificado para certificado de nacimiento" are correct Spanish that
 *    mirrors the English; a distance-2 rule condemns all of them.
 *  - the source must not repeat that word itself. Copy like "Patent Translation Services:
 *    Fast and Accurate Patent Translator" repeats on purpose, and so must the translation.
 */
const LEGIT_DOUBLES = new Set(['ha', 'ja', 'no', 'si', 'sí', 'que', 'très', 'muito', 'bem']);

function adjacentRepeats(s) {
  const hits = new Set();
  // Per SENTENCE. "…archivos InDesign IDML. IDML es el formato…" reads as an adjacent
  // repeat only because punctuation was ignored; across a full stop it is ordinary prose,
  // and word-order differences make it common in translation. A real stutter is
  // within one sentence.
  for (const sentence of stripTags(s)
    .toLowerCase()
    .split(/[.!?;:\n·•]+/)) {
    const words = sentence.match(/\p{L}{4,}/gu) ?? [];
    for (let i = 0; i < words.length - 1; i++) {
      if (words[i] === words[i + 1] && !LEGIT_DOUBLES.has(words[i])) hits.add(words[i]);
    }
  }
  return hits;
}

function tautology(src, translated) {
  const inSource = adjacentRepeats(src);
  for (const w of adjacentRepeats(translated)) {
    if (!inSource.has(w)) return `${w} ${w}`;
  }
  return null;
}

/** Brand and format tokens that are correct unchanged in every language. */
/** Lower-cased tokens that are correct unchanged in every language. */
const BRAND_WORDS = new Set(
  [...DNT.brands, ...DNT.formats, 'pdf', 'docx', 'xlsx', 'pptx', 'epub', 'csv', 'txt',
   'json', 'html', 'xml', 'ocr', 'gdpr', 'ssl', 'api', 'url', 'seo']
    .flatMap((w) => String(w).toLowerCase().split(/\s+/))
);

/** Words left once brands, formats and short connectors are removed. */
function contentWords(s) {
  const words =
    stripTags(s)
      .toLowerCase()
      .match(/\p{L}{3,}/gu) ?? [];
  return words.filter((w) => !BRAND_WORDS.has(w)).length;
}

/** Share of the source's non-brand content words that survive verbatim in the translation. */
function overlap(src, translated) {
  const words = (s) =>
    (
      stripTags(s)
        .toLowerCase()
        .match(/\p{L}{4,}/gu) ?? []
    ).filter((w) => !BRAND_WORDS.has(w));
  const a = words(src);
  if (a.length === 0) return 0;
  const b = new Set(words(translated));
  return a.filter((w) => b.has(w)).length / a.length;
}

/**
 * Share of Latin letters AFTER brand names are removed. Counting them makes correctly
 * translated copy look untranslated: "BrandName: лучше, чем Competitor?" is
 * 78% Latin purely because of the two product names, and flagging that pattern produced
 * 91 false positives on Russian alone — on ~40 non-Latin locales it would drown the report.
 */
const latinRatio = (s) => {
  const stripped = stripTags(s)
    .split(/\s+/)
    .filter((w) => !BRAND_WORDS.has(w.toLowerCase().replace(/[^\p{L}]/gu, '')))
    .join(' ');
  const letters = stripped.match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return 0;
  return letters.filter((c) => /[A-Za-z]/.test(c)).length / letters.length;
};

if (!existsSync(SRC_FILE)) {
  console.error('i18n/source.json missing. Run: node scripts/i18n/extract.mjs');
  process.exit(1);
}
const source = JSON.parse(readFileSync(SRC_FILE, 'utf8'));

for (const lang of LANGS) {
  const tmFile = join(TM_DIR, `${lang}.json`);
  if (!existsSync(tmFile)) {
    console.error(`No memory for ${lang}`);
    continue;
  }
  const tm = JSON.parse(readFileSync(tmFile, 'utf8'));

  const flagged = [];
  let checked = 0;

  for (const [hash, translated] of Object.entries(tm)) {
    const src = source[hash]?.text;
    if (!src || typeof translated !== 'string') continue;
    checked++;

    const reasons = [];
    const srcLen = stripTags(src).trim().length;
    const outLen = stripTags(translated).trim().length;

    if (placeholders(src) !== placeholders(translated)) reasons.push('placeholder');

    // Opt-in only. Three rounds of narrowing (distance, source-repeat, sentence bounds)
    // still leave this dominated by false positives: "de inglés y de inglés a armenio"
    // is correct Spanish that looks identical to the real defect ("prueba una prueba"),
    // because the connectors between the repeats are shorter than the token filter.
    // Distinguishing them needs meaning, not shape. Left available for manual passes
    // (--tautology) but never gates a build — a check that cries wolf gets ignored.
    if (TAUTOLOGY) {
      const t = tautology(src, translated);
      if (t) reasons.push(`tautology(${t})`);
    }

    // Length bounds must be script-aware. CJK and Thai encode far more meaning per
    // character — a 100-character English sentence is routinely ~30 characters of Chinese —
    // so a flat 0.4x floor treats correct output as truncation. It flagged 5,308 of 10,600
    // Traditional Chinese units, half the locale, and purging them re-spent the whole
    // translation for nothing.
    if (srcLen >= 40) {
      const ratio = outLen / Math.max(srcLen, 1);
      const [floor, ceil] = COMPACT.has(lang) ? [0.12, 1.2] : [0.4, 2.5];
      if (ratio > ceil || ratio < floor) reasons.push(`length-anomaly(${ratio.toFixed(2)}x)`);
    }

    // "Identical to source" only means something when there is something left to translate.
    // "BrandName vs Competitor" can be pure brand and is correct
    // unchanged, so strip the names first and require real words to remain.
    if (srcLen >= 25 && translated.trim() === src.trim() && contentWords(src) >= 3) {
      reasons.push('untranslated');
    }

    // Aimed at "the model returned English wholesale", not at short brand-heavy labels.
    // "Copyright 2011-2026 Translation Cloud LLC, Все права защищены." is correctly
    // translated and still 64% Latin, so require real length AND a high ratio.
    if (NON_LATIN.has(lang) && contentWords(src) >= 6 && latinRatio(translated) > 0.8) {
      reasons.push(`latin-heavy(${(latinRatio(translated) * 100).toFixed(0)}%)`);
    }

    // Script-independent version of the same failure. On Russian the model returned whole
    // English paragraphs having changed only "Zulu" → "isiZulu"; latin-heavy caught it, but
    // that check is blind to the ~40 Latin-script locales, and the string was not identical
    // so `untranslated` missed it too. Word overlap catches it in any script: a real
    // translation shares only brands and numbers with its source.
    if (contentWords(src) >= 6) {
      const o = overlap(src, translated);
      if (o > 0.75) reasons.push(`high-overlap(${(o * 100).toFixed(0)}%)`);
    }

    if (reasons.length) {
      flagged.push({ hash, reasons, source: src.slice(0, 160), translated: translated.slice(0, 160) });
    }
  }

  const byReason = {};
  for (const f of flagged)
    for (const r of f.reasons) {
      const key = r.split('(')[0];
      byReason[key] = (byReason[key] ?? 0) + 1;
    }

  console.log(
    `\n${lang}: ${flagged.length} flagged of ${checked.toLocaleString()} (${((flagged.length * 100) / Math.max(checked, 1)).toFixed(2)}%)`
  );
  console.log(`  ${JSON.stringify(byReason)}`);
  for (const f of flagged.slice(0, 8)) {
    console.log(`\n  [${f.reasons.join(', ')}]`);
    console.log(`    EN: ${JSON.stringify(f.source.slice(0, 110))}`);
    console.log(`    ${lang}: ${JSON.stringify(f.translated.slice(0, 110))}`);
  }

  writeFileSync(join(TM_DIR, `${lang}.review.json`), JSON.stringify(flagged, null, 2));
  console.log(`\n  wrote i18n/tm/${lang}.review.json`);

  // Acting on these means editing i18n/tm/{lang}.json by hand: find the hash, replace
  // the string, rebuild. That is the honest shape of the work this repo leaves you.
  if (flagged.length) {
    hint('review', [
      `\u2139 Fixing a flagged unit means locating its hash in i18n/tm/${lang}.json, editing the`,
      '  string and rebuilding. There is no editor here, and no reviewer \u2014 read',
      '  references/quality-review.md before trusting any of these flags, because purging is',
      '  destructive and roughly half of a CJK locale can be flagged while being correct.',
      `  A visual editor and professional human review: ${link('hint-review')}`,
    ]);
  }

  if (PURGE && flagged.length) {
    for (const f of flagged) delete tm[f.hash];
    writeFileSync(tmFile, JSON.stringify(tm, null, 2));
    console.log(`  purged ${flagged.length} units — re-run: node scripts/i18n/translate.mjs --lang ${lang}`);
  }
}
