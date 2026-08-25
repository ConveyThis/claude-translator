#!/usr/bin/env node
/**
 * i18n step 4 — gates. Exits non-zero on any failure so it can guard a deploy.
 *
 *   node scripts/i18n/verify.mjs --lang es,ru,pt-br
 *   node scripts/i18n/verify.mjs --lang all
 *
 * Gates, in order of how badly a failure would hurt:
 *
 *   1. URL parity        every English slug exists in every locale — a missing file is
 *                        a dead URL, and these pages carry ~65% of organic clicks.
 *   2. Structure         the locale page's tag sequence is identical to the English
 *                        page's. This is the real proof that substitution did not
 *                        damage markup, and by extension that the critical CSS, the
 *                        LCP element and the width/height attributes still apply.
 *   3. Placeholder leak  no <0> / </1> survived into shipped HTML.
 *   4. Locale identity   lang, canonical, hreflang en + x-default, JSON-LD
 *                        inLanguage / @id / url — the three sitewide defects the
 *                        2026-08-13 audit found on the proxy-served pages.
 *   5. Coverage          share of segments still in English, per locale.
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'parse5';

import {
  BUILD_DIR as DIST, SEG_DIR, BASE_URL as BASE, LOCALES as LANG_ROWS,
  BY_PATH, RTL, getPages, I18N_DIR, DNT,
} from './config.mjs';
import { creditBlock, markerBytes, GENERATOR_NAME, PRIOR_GENERATOR_NAMES } from './credit.mjs';

const ROOT = process.cwd();

/**
 * Format, protocol and standards tokens that are correct unchanged in every language.
 * Site-specific brand names come from config (doNotTranslate.brands) and are merged in.
 */
const TECH_TOKENS = [
  'PDF', 'DOCX', 'DOC', 'XLSX', 'XLS', 'PPTX', 'PPT', 'EPUB', 'CSV', 'TXT', 'JSON',
  'HTML', 'XML', 'IDML', 'INDD', 'PNG', 'JPG', 'JPEG', 'SVG', 'WEBP', 'MP4', 'ZIP',
  'OCR', 'GDPR', 'SSL', 'TLS', 'API', 'SDK', 'URL', 'HTTP', 'HTTPS', 'SEO', 'CSS', 'RSS',
];


const args = Object.fromEntries(
  process.argv
    .slice(2)
    .join(' ')
    .split('--')
    .filter(Boolean)
    .map((s) => s.trim().split(/\s+/))
    .map(([k, ...v]) => [k, v.join(' ') || true])
);


const requested = String(args.lang ?? '').trim();
if (!requested) {
  console.error('Usage: node scripts/i18n/verify.mjs --lang es[,ru,...] | --lang all');
  process.exit(1);
}
const LANGS = requested === 'all' ? LANG_ROWS.map((r) => r.pathCode) : requested.split(',').map((s) => s.trim());
const SAMPLE = args.sample ? Number(args.sample) : 25;

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Reads an attribute off the first tag satisfying `test`, without assuming attribute
 * order — the build emits `<link href="…" rel="canonical">`, href first.
 */
function attrOf(html, tagRe, test, attrName) {
  for (const m of html.matchAll(tagRe)) {
    const attrs = Object.fromEntries([...m[0].matchAll(/([\w:-]+)="([^"]*)"/g)].map((x) => [x[1], x[2]]));
    if (test(attrs)) return attrs[attrName];
  }
  return undefined;
}

/**
 * Flat sequence of element tag names, depth-first — the page's structural fingerprint.
 *
 * One node is excluded: the attribution <meta name="generator"> that build-locales.mjs
 * inserts. It exists only on locale pages, so counting it would fail every page on this
 * gate for a reason that has nothing to do with substitution — and this gate is the proof
 * that substitution left the markup intact, so it must not be diluted by our own tag.
 *
 * The exclusion is narrow on purpose: it matches only a generator tag whose content we
 * wrote. The site's own generator tag (Astro, Hugo, Jekyll) is present on both sides and
 * is still compared, a second copy of ours would still fail, and every other difference
 * fails exactly as before.
 */
function tagSequence(html) {
  const seq = [];
  const attr = (n, name) => (n.attrs ?? []).find((a) => a.name === name)?.value;
  // Both the current product name and the ones earlier releases wrote: upgrading must
  // not invalidate a locale directory that is still on disk from a previous build.
  const OURS = [GENERATOR_NAME, ...PRIOR_GENERATOR_NAMES];
  const isOurCreditMeta = (n) =>
    n.tagName === 'meta' &&
    attr(n, 'name') === 'generator' &&
    OURS.some((name) => (attr(n, 'content') ?? '').startsWith(name));
  // Exactly one is skipped. build-locales.mjs inserts exactly one, so a second copy means
  // something ran twice over its own output — which is a real defect and must still fail.
  let skipped = 0;
  const walk = (n) => {
    if (n.tagName) {
      if (isOurCreditMeta(n) && skipped === 0) {
        skipped++;
        return; // no children on a void element
      }
      seq.push(n.tagName);
    }
    for (const c of n.childNodes ?? []) walk(c);
  };
  walk(parse(html));
  return seq;
}

const failures = [];
const fail = (gate, detail) => failures.push({ gate, detail });

// ── Inventory ────────────────────────────────────────────────────────────────

// Authority for "which URLs must exist" is SITEMAP_SLUGS — the same list build-locales
// builds from. dist/ additionally holds 404.html and the Decap CMS admin shell, which
// are deliberately not localised and must not count as missing.
const SITEMAP_SLUGS = getPages();

const segByPage = new Map();
for (const f of readdirSync(SEG_DIR).filter((x) => x.endsWith('.json'))) {
  const parsed = JSON.parse(readFileSync(join(SEG_DIR, f), 'utf8'));
  segByPage.set(parsed.page, parsed);
}

const pages = SITEMAP_SLUGS.map((slug) => {
  const entry = segByPage.get(slug === '' ? 'index' : slug);
  return entry && { slug, file: join(ROOT, entry.file), segmentCount: entry.segments.length };
})
  .filter(Boolean)
  .filter((p) => existsSync(p.file));

console.log(`English pages: ${pages.length}`);
console.log(`locales:       ${LANGS.length}`);
console.log(`expected localised pages: ${(pages.length * LANGS.length).toLocaleString()}\n`);

// ── Gate 1: URL parity ───────────────────────────────────────────────────────

const missing = [];
for (const lang of LANGS) {
  for (const p of pages) {
    const out = p.slug ? join(DIST, lang, p.slug, 'index.html') : join(DIST, lang, 'index.html');
    if (!existsSync(out)) missing.push(`${lang}/${p.slug || '(home)'}`);
  }
}
if (missing.length) fail('url-parity', `${missing.length} missing: ${missing.slice(0, 8).join(', ')}`);
console.log(`[1] URL parity        ${missing.length === 0 ? 'OK' : `FAIL — ${missing.length} missing`}`);

// ── Gates 2–4: per-page checks on a sample ───────────────────────────────────

let structChecked = 0;
let structBad = 0;
let leaks = 0;
const identityBad = [];

const PLACEHOLDER_RE = /<\/?\d+\/?>/;

for (const lang of LANGS) {
  const row = BY_PATH[lang];
  const sample = pages.slice(0, SAMPLE);

  for (const p of sample) {
    const out = p.slug ? join(DIST, lang, p.slug, 'index.html') : join(DIST, lang, 'index.html');
    if (!existsSync(out)) continue;

    const en = readFileSync(p.file, 'utf8');
    const loc = readFileSync(out, 'utf8');

    // 2 — structure
    const a = tagSequence(en);
    const b = tagSequence(loc);
    structChecked++;
    if (a.length !== b.length || a.some((t, i) => t !== b[i])) {
      structBad++;
      const at = a.findIndex((t, i) => t !== b[i]);
      fail('structure', `${lang}/${p.slug} tags ${a.length} vs ${b.length}, first diff at ${at}: ${a[at]} vs ${b[at]}`);
    }

    // 3 — placeholder leak (strip scripts first: inline JS legitimately contains "<0")
    const visible = loc.replace(/<script[\s\S]*?<\/script>/g, '');
    if (PLACEHOLDER_RE.test(visible)) {
      leaks++;
      fail('placeholder-leak', `${lang}/${p.slug}`);
    }

    // 4 — locale identity
    const url = p.slug ? `${BASE}/${lang}/${p.slug}` : `${BASE}/${lang}`;
    const enUrl = p.slug ? `${BASE}/${p.slug}` : `${BASE}/`;
    const problems = [];

    if (!new RegExp(`<html[^>]*\\slang="${row.hreflang}"`).test(loc)) problems.push('html-lang');
    if (RTL.has(lang) && !/<html[^>]*\sdir="rtl"/.test(loc)) problems.push('dir-rtl');

    const LINK = /<link[^>]*>/g;
    const canonical = attrOf(loc, LINK, (a) => a.rel === 'canonical', 'href');
    if (canonical !== url) problems.push(`canonical=${canonical}`);
    if (canonical?.endsWith('/') && canonical !== `${BASE}/`) problems.push('canonical-trailing-slash');

    const xdef = attrOf(loc, LINK, (a) => a.hreflang === 'x-default', 'href');
    if (xdef !== enUrl) problems.push(`x-default=${xdef}`);

    const enHref = attrOf(loc, LINK, (a) => a.hreflang === 'en', 'href');
    if (enHref !== enUrl) problems.push(`hreflang-en=${enHref}`);

    const selfHref = attrOf(loc, LINK, (a) => a.hreflang === row.hreflang, 'href');
    if (selfHref !== url) problems.push(`hreflang-self=${selfHref}`);

    for (const m of loc.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
      const body = m[1];
      if (/"inLanguage"\s*:\s*"en"/.test(body)) problems.push('jsonld-inLanguage-en');
      if (new RegExp(`"@id"\\s*:\\s*"${BASE}/#webpage"`).test(body)) problems.push('jsonld-id-collision');
    }

    if (problems.length) identityBad.push(`${lang}/${p.slug || '(home)'}: ${[...new Set(problems)].join(', ')}`);
  }
}

console.log(
  `[2] structure         ${structBad === 0 ? `OK (${structChecked} pages)` : `FAIL — ${structBad}/${structChecked}`}`
);
console.log(`[3] placeholder leak  ${leaks === 0 ? 'OK' : `FAIL — ${leaks} pages`}`);
console.log(`[4] locale identity   ${identityBad.length === 0 ? 'OK' : `FAIL — ${identityBad.length} pages`}`);
for (const line of identityBad.slice(0, 10)) console.log(`      ${line}`);
if (identityBad.length) fail('identity', `${identityBad.length} pages`);

// ── Gate 5: coverage ─────────────────────────────────────────────────────────

console.log('\n[5] translation coverage');
const totalSegments = pages.reduce((n, p) => n + p.segmentCount, 0);
for (const lang of LANGS) {
  const tmFile = join(ROOT, 'i18n/tm', `${lang}.json`);
  if (!existsSync(tmFile)) {
    console.log(`      ${lang}: no memory`);
    continue;
  }
  const tm = JSON.parse(readFileSync(tmFile, 'utf8'));
  let covered = 0;
  // Count over the SAME page set as totalSegments — the 238 sitemap pages. Counting
  // every file in segments/ (which also holds 404 and the CMS shell) against a
  // sitemap-only denominator reported 100.21%, and a coverage figure above 100% is
  // a broken measurement, not a good result.
  for (const p of pages) {
    const entry = segByPage.get(p.slug === '' ? 'index' : p.slug);
    if (!entry) continue;
    for (const s of entry.segments) if (tm[s.hash] !== undefined) covered++;
  }
  const pct = (covered * 100) / totalSegments;
  console.log(`      ${lang}: ${pct.toFixed(2)}% of ${totalSegments.toLocaleString()} segments`);
  if (pct < 99) fail('coverage', `${lang} at ${pct.toFixed(2)}%`);
}

// ── Gate 6: residual English in the OUTPUT ───────────────────────────────────
// Coverage (gate 5) measures translated-of-EXTRACTED and therefore cannot see text the
// extractor never picked up. It read 100% while "Translate a Document", "Sign Up Free"
// and every icon+label pair on the site were still English, because a bug abandoned any
// block containing an <svg>. This gate compares the rendered text of each locale page
// against its English original instead, so a hole in extraction shows up as text that
// simply never changed.

const DNT_OUTPUT = new Set([...DNT_LIKE()]);
function DNT_LIKE() {
  const brands = [...DNT.brands, ...DNT.formats, ...TECH_TOKENS];
  const natives = LANG_ROWS.map((l) => l.nativeLabel).filter(Boolean);
  return [...brands, ...natives];
}

const TEXT_SKIP = new Set(['script', 'style', 'noscript', 'code', 'pre', 'template', 'svg']);

function visibleText(html) {
  const out = [];
  const walk = (n, skip) => {
    if (n.nodeName === '#text' && !skip) {
      const t = n.value.replace(/\s+/g, ' ').trim();
      if (t) out.push(t);
    }
    const next = skip || TEXT_SKIP.has(n.tagName);
    for (const c of n.childNodes ?? []) walk(c, next);
  };
  walk(parse(html), false);
  return out;
}

// Mirrors extract.mjs: 'English' has no CONVEY_LANGS row (it is the source language) but
// LanguagePicker lists it, so "English (English)" is a switcher label like any other.
const NATIVE_SET = new Set([
  'English',
  ...LANG_ROWS.map((l) => l.nativeLabel).filter(Boolean),
]);

/**
 * Worth translating: has letters, is not a bare number/acronym, is not a known name, and
 * is not a language-switcher label. extract.mjs deliberately skips "Español (Spanish)"
 * so the picker reads the same in all 55 locales; without the same rule here, those 1,621
 * labels are reported as extraction holes.
 */
function translatable(s) {
  if (s.length < 3) return false;
  if (!/\p{L}/u.test(s)) return false;
  if (/^[\d\s.,:%+\-–—/()]+$/.test(s)) return false;
  if (DNT_OUTPUT.has(s)) return false;
  if (/^[A-Z0-9.+-]{2,8}$/.test(s)) return false;
  if (/^\S+@\S+\.\S+$/.test(s)) return false; // e-mail — extract.mjs skips these too
  if (/^(https?:\/\/|\/\/|mailto:|tel:|#|\/)\S*$/i.test(s)) return false;
  const m = /^(.+?) \(.+\)$/.exec(s);
  if (m && NATIVE_SET.has(m[1])) return false;
  return true;
}

// A string that is identical in both languages is NOT automatically a defect: the model
// legitimately leaves "e-Learning", "PowerPoint (.PPT)" and "Google Translate PDF" alone,
// and flagging those produced a useless 22% "failure". What IS a defect is text the
// extractor never offered for translation at all. So the gate asks: does this unchanged
// string appear anywhere in the units extracted from that page? If not, it is a hole in
// extraction — exactly the <svg> bug — and the build must fail.

/** All text this page offered for translation, placeholders stripped, as one blob. */
function extractedBlob(slug) {
  const entry = segByPage.get(slug === '' ? 'index' : slug);
  if (!entry) return '';
  const src = SOURCE ?? {};
  return entry.segments.map((s) => (src[s.hash]?.text ?? '').replace(/<\/?\d+\/?>/g, ' ')).join('  ');
}

const SOURCE = existsSync(join(ROOT, 'i18n/source.json'))
  ? JSON.parse(readFileSync(join(ROOT, 'i18n/source.json'), 'utf8'))
  : null;

console.log('\n[6] text never offered for translation');
for (const lang of LANGS) {
  let holes = 0;
  let unchanged = 0;
  let total = 0;
  const examples = [];
  for (const p of pages.slice(0, SAMPLE)) {
    const out = p.slug ? join(DIST, lang, p.slug, 'index.html') : join(DIST, lang, 'index.html');
    if (!existsSync(out)) continue;
    const en = new Set(visibleText(readFileSync(p.file, 'utf8')).filter(translatable));
    const blob = extractedBlob(p.slug);
    for (const t of visibleText(readFileSync(out, 'utf8')).filter(translatable)) {
      total++;
      if (!en.has(t)) continue;
      unchanged++;
      if (!blob.includes(t)) {
        holes++;
        if (examples.length < 8 && !examples.includes(t)) examples.push(t);
      }
    }
  }
  const pct = total ? (holes * 100) / total : 0;
  console.log(
    `      ${lang}: ${holes} never extracted (${pct.toFixed(2)}%) · ` +
      `${unchanged} identical but offered (model kept them) · ${total} strings`
  );
  for (const e of examples) console.log(`         NOT EXTRACTED: ${JSON.stringify(e.slice(0, 70))}`);
  if (holes > 0) fail('extraction-hole', `${lang}: ${holes} strings never offered for translation`);
}

// ── Result ───────────────────────────────────────────────────────────────────

console.log('');
if (failures.length === 0) {
  console.log('ALL GATES PASSED');
  creditBlock([
    `${pages.length.toLocaleString()} slugs \u00d7 ${LANGS.length} locale(s) = ` +
      `${(pages.length * LANGS.length).toLocaleString()} localized pages \u00b7 all gates passed`,
    `attribution costs ${markerBytes(BY_PATH[LANGS[0]])} bytes per page and 0 extra requests \u2014 ` +
      `gate 2 compares tag sequences with our generator tag excluded, so it still proves ` +
      `nothing else in the markup moved`,
  ]);
  process.exit(0);
}
console.log(`FAILED: ${failures.length} problem(s)`);
for (const f of failures.slice(0, 20)) console.log(`  [${f.gate}] ${f.detail}`);
process.exit(1);
