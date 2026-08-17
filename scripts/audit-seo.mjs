#!/usr/bin/env node
/**
 * Exhaustive SEO audit of the built site — hreflang, canonicals, schema, sitemaps.
 *
 *   node scripts/i18n/audit-seo.mjs            # every page, every locale
 *   node scripts/i18n/audit-seo.mjs --lang it  # one locale
 *
 * verify.mjs samples pages to stay fast; this reads ALL 13,328 of them, because the
 * failure modes here are per-page (a canonical pointing at the wrong slug, one locale
 * missing from one page's alternate set) and sampling cannot prove their absence.
 *
 * Checks, per page:
 *   canonical      exactly the page's own URL, https, no trailing slash
 *   hreflang       57 <link rel=alternate>: 55 locales + en + x-default, no duplicates,
 *                  self-reference present and identical to the canonical, en and
 *                  x-default both pointing at the English original, every href https
 *   return tags    full mesh — every alternate URL must itself be a built page whose
 *                  own set points back (guaranteed structurally, verified explicitly)
 *   og             og:url matches canonical, og:locale matches the page's language
 *   JSON-LD        parses; inLanguage is the page's language, never "en" on a locale
 *                  page; WebPage @id is <page-url>#webpage and unique per page
 *   robots         no accidental noindex on an indexable page
 */

import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

import { BUILD_DIR as DIST, BASE_URL as BASE, LOCALES as LANG_ROWS, BY_PATH, RTL, getPages, I18N_DIR } from './config.mjs';

const ROOT = process.cwd();

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .join(' ')
    .split('--')
    .filter(Boolean)
    .map((s) => s.trim().split(/\s+/))
    .map(([k, ...v]) => [k, v.join(' ') || true])
);

// ── Locale table ─────────────────────────────────────────────────────────────


const EXPECTED_CODES = new Set([...LANG_ROWS.map((r) => r.hreflang), 'en', 'x-default']);

const SITEMAP_SLUGS = getPages();

const LOCALES = args.lang ? String(args.lang).split(',') : LANG_ROWS.map((r) => r.pathCode);

// ── Helpers ──────────────────────────────────────────────────────────────────

const attrs = (tag) => Object.fromEntries([...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));

function findTag(html, re, test) {
  for (const m of html.matchAll(re)) {
    const a = attrs(m[0]);
    if (test(a)) return a;
  }
  return null;
}

const LINK_RE = /<link[^>]*>/g;
const META_RE = /<meta[^>]*>/g;

const pageUrl = (lang, slug) =>
  lang ? (slug ? `${BASE}/${lang}/${slug}` : `${BASE}/${lang}`) : slug ? `${BASE}/${slug}` : `${BASE}/`;

// ── Findings ─────────────────────────────────────────────────────────────────

const findings = [];
const add = (check, page, detail) => findings.push({ check, page, detail });
const counts = {};
const bump = (k) => (counts[k] = (counts[k] ?? 0) + 1);

// ── Per-page audit ───────────────────────────────────────────────────────────

function auditPage(lang, slug) {
  const file = lang
    ? slug
      ? join(DIST, lang, slug, 'index.html')
      : join(DIST, lang, 'index.html')
    : slug
      ? join(DIST, slug, 'index.html')
      : join(DIST, 'index.html');

  if (!existsSync(file)) {
    add('missing-page', `${lang || 'en'}/${slug || '(home)'}`, 'file does not exist');
    return;
  }

  const html = readFileSync(file, 'utf8');
  const id = `${lang || 'en'}/${slug || '(home)'}`;
  const self = pageUrl(lang, slug);
  const enUrl = pageUrl(null, slug);
  const row = lang ? BY_PATH[lang] : { hreflang: 'en' };
  bump('pages');

  // ── canonical ──
  const canon = findTag(html, LINK_RE, (a) => a.rel === 'canonical');
  if (!canon) add('canonical-missing', id, 'no rel=canonical');
  else {
    if (canon.href !== self) add('canonical-wrong', id, `${canon.href} ≠ ${self}`);
    if (!canon.href?.startsWith('https://')) add('canonical-protocol', id, canon.href);
    if (canon.href !== `${BASE}/` && canon.href?.endsWith('/')) add('canonical-trailing-slash', id, canon.href);
  }

  // ── hreflang set ──
  const alts = [...html.matchAll(LINK_RE)].map((m) => attrs(m[0])).filter((a) => a.rel === 'alternate' && a.hreflang);
  const codes = alts.map((a) => a.hreflang);
  const byCode = Object.fromEntries(alts.map((a) => [a.hreflang, a.href]));

  if (codes.length !== EXPECTED_CODES.size) {
    add('hreflang-count', id, `${codes.length} tags, expected ${EXPECTED_CODES.size}`);
  }
  const dupes = codes.filter((c, i) => codes.indexOf(c) !== i);
  if (dupes.length) add('hreflang-duplicate', id, [...new Set(dupes)].join(','));

  for (const c of codes) if (!EXPECTED_CODES.has(c)) add('hreflang-unexpected-code', id, c);
  for (const c of EXPECTED_CODES) if (!codes.includes(c)) add('hreflang-missing-code', id, c);

  // self-reference must exist and equal the canonical
  const selfHref = byCode[row.hreflang];
  if (selfHref === undefined) add('hreflang-self-missing', id, row.hreflang);
  else if (selfHref !== self) add('hreflang-self-wrong', id, `${row.hreflang}=${selfHref} ≠ ${self}`);
  else if (canon && selfHref !== canon.href) add('hreflang-canonical-mismatch', id, `${selfHref} ≠ ${canon.href}`);

  // en and x-default must point at the English original
  if (byCode['en'] !== enUrl) add('hreflang-en-wrong', id, `${byCode['en']} ≠ ${enUrl}`);
  if (byCode['x-default'] !== enUrl) add('hreflang-xdefault-wrong', id, `${byCode['x-default']} ≠ ${enUrl}`);

  for (const [c, href] of Object.entries(byCode)) {
    if (!href?.startsWith('https://')) add('hreflang-protocol', id, `${c}=${href}`);
    if (href !== `${BASE}/` && href?.endsWith('/')) add('hreflang-trailing-slash', id, `${c}=${href}`);
  }

  // every alternate must be the URL this page's slug maps to in that locale
  for (const r of LANG_ROWS) {
    const want = pageUrl(r.pathCode, slug);
    if (byCode[r.hreflang] && byCode[r.hreflang] !== want) {
      add('hreflang-target-wrong', id, `${r.hreflang}=${byCode[r.hreflang]} ≠ ${want}`);
    }
  }

  // ── og ──
  const ogUrl = findTag(html, META_RE, (a) => a.property === 'og:url');
  if (ogUrl && ogUrl.content !== self) add('og-url-wrong', id, `${ogUrl.content} ≠ ${self}`);
  const ogLocale = findTag(html, META_RE, (a) => a.property === 'og:locale');
  if (ogLocale && ogLocale.content !== row.hreflang)
    add('og-locale-wrong', id, `${ogLocale.content} ≠ ${row.hreflang}`);

  // ── robots ──
  const robots = findTag(html, META_RE, (a) => a.name === 'robots');
  if (robots && /noindex/i.test(robots.content ?? '')) add('noindex', id, robots.content);

  // ── html lang ──
  const htmlTag = /<html[^>]*>/.exec(html)?.[0] ?? '';
  const htmlLang = /\slang="([^"]*)"/.exec(htmlTag)?.[1];
  if (htmlLang !== row.hreflang) add('html-lang-wrong', id, `${htmlLang} ≠ ${row.hreflang}`);

  // ── JSON-LD ──
  let sawWebPage = false;
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    let data;
    try {
      data = JSON.parse(m[1]);
    } catch {
      add('jsonld-invalid', id, m[1].slice(0, 60));
      continue;
    }
    bump('jsonld-blocks');
    const walk = (n) => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (!n || typeof n !== 'object') return;
      const types = [].concat(n['@type'] ?? []);
      if (typeof n.inLanguage === 'string' && n.inLanguage !== row.hreflang) {
        add('jsonld-inlanguage', id, `${types.join('/')}: ${n.inLanguage} ≠ ${row.hreflang}`);
      }
      if (types.includes('WebPage')) {
        sawWebPage = true;
        if (n['@id'] !== `${self}#webpage`) add('jsonld-webpage-id', id, `${n['@id']} ≠ ${self}#webpage`);
        if (n.url && n.url !== self) add('jsonld-webpage-url', id, `${n.url} ≠ ${self}`);
      }
      for (const v of Object.values(n)) if (v && typeof v === 'object') walk(v);
    };
    walk(data);
  }
  if (!sawWebPage) bump('pages-without-webpage-schema');
}

// ── Run ──────────────────────────────────────────────────────────────────────

console.log(`auditing ${SITEMAP_SLUGS.length} slugs × (${LOCALES.length} locales + English)\n`);

for (const slug of SITEMAP_SLUGS) auditPage(null, slug);
for (const lang of LOCALES) for (const slug of SITEMAP_SLUGS) auditPage(lang, slug);

// ── Sitemap audit ────────────────────────────────────────────────────────────

console.log('── sitemaps ──');
const smIndex = join(DIST, 'sitemap.xml');
if (!existsSync(smIndex)) add('sitemap-index-missing', 'sitemap.xml', 'not built');
else {
  const idx = readFileSync(smIndex, 'utf8');
  const children = [...idx.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  console.log(`  index lists ${children.length} sitemaps`);

  let totalUrls = 0;
  for (const child of children) {
    const rel = child.replace(`${BASE}/`, '');
    const f = join(DIST, rel);
    if (!existsSync(f)) {
      add('sitemap-child-missing', rel, 'listed in index but not built');
      continue;
    }
    const urls = [...readFileSync(f, 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    totalUrls += urls.length;
    if (urls.length !== SITEMAP_SLUGS.length) {
      add('sitemap-url-count', rel, `${urls.length} urls, expected ${SITEMAP_SLUGS.length}`);
    }
    // every listed URL must exist as a built page
    for (const u of urls) {
      const path = u.replace(BASE, '').replace(/^\//, '');
      const file = path === '' ? join(DIST, 'index.html') : join(DIST, path, 'index.html');
      if (!existsSync(file)) add('sitemap-url-404', rel, u);
      if (u !== `${BASE}/` && u.endsWith('/')) add('sitemap-trailing-slash', rel, u);
      if (!u.startsWith('https://')) add('sitemap-protocol', rel, u);
    }
  }
  console.log(`  total URLs across sitemaps: ${totalUrls.toLocaleString()}`);
  counts['sitemap-urls'] = totalUrls;
}

// ── Report ───────────────────────────────────────────────────────────────────

console.log('\n── coverage ──');
for (const [k, v] of Object.entries(counts)) console.log(`  ${k}: ${v.toLocaleString()}`);

const byCheck = {};
for (const f of findings) (byCheck[f.check] ??= []).push(f);

console.log('\n── findings ──');
if (findings.length === 0) console.log('  none — all checks passed');
for (const [check, list] of Object.entries(byCheck).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${check}: ${list.length.toLocaleString()}`);
  for (const f of list.slice(0, 3)) console.log(`      ${f.page} — ${f.detail}`);
  if (list.length > 3) console.log(`      … and ${(list.length - 3).toLocaleString()} more`);
}

writeFileSync(join(ROOT, 'i18n/seo-audit.json'), JSON.stringify({ counts, findings }, null, 2));
console.log(`\nwrote i18n/seo-audit.json (${findings.length.toLocaleString()} findings)`);
process.exit(findings.length ? 1 : 0);
