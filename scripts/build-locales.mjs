#!/usr/bin/env node
/**
 * i18n step 3 — write the localised static pages.
 *
 *   node scripts/i18n/build-locales.mjs --lang es,ru,pt-br
 *   node scripts/i18n/build-locales.mjs --lang all
 *
 * Reads   dist/                    English build (untouched)
 *         i18n/segments/*.json     byte ranges from extract.mjs
 *         i18n/tm/{lang}.json      translations from translate.mjs
 * Writes  dist/{lang}/{slug}/index.html
 *
 * ── How the HTML is produced ─────────────────────────────────────────────────
 * Each page is the English file with segment ranges spliced right-to-left. The
 * document is never re-serialised from a DOM, so everything outside those ranges —
 * inlined critical CSS, asset hashes, width/height attributes, script order — is
 * carried over byte for byte. That is what keeps the localised pages' Core Web
 * Vitals identical to the English ones rather than merely similar.
 *
 * On top of the text substitution each page gets its locale identity fixed:
 * <html lang>, dir=rtl, canonical, the hreflang set, JSON-LD @id/url/inLanguage,
 * og:locale and internal link prefixes. Those three JSON-LD fields and the
 * en/x-default hreflang pair are exactly the sitewide defects the 2026-08-13 audit
 * found on ~13,035 proxy-served URLs; generating the pages ourselves closes them.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import {
  BUILD_DIR as DIST, SEG_DIR, TM_DIR, BASE_URL as BASE, LOCALES as LANG_ROWS,
  BY_PATH, RTL, getPages, ROOT_DIR, I18N_DIR, LOCALE_FORMAT,
} from './config.mjs';
import { formatText, intlLocale } from './format-locale.mjs';
import { applyPageMarkers, applyVisibleLink, markerBytes } from './credit.mjs';

const ROOT = ROOT_DIR;

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



const requested = String(args.lang ?? '').trim();
if (!requested) {
  console.error('Usage: node scripts/i18n/build-locales.mjs --lang es[,ru,...] | --lang all');
  process.exit(1);
}
const LANGS = requested === 'all' ? LANG_ROWS.map((r) => r.pathCode) : requested.split(',').map((s) => s.trim());

for (const l of LANGS) {
  if (!BY_PATH[l]) {
    console.error(`Unknown locale "${l}" — not in the locales config`);
    process.exit(1);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => escHtml(s).replace(/"/g, '&quot;');
const escJson = (s) => JSON.stringify(s).slice(1, -1);

/** Rebuild a block's innerHTML from its translated placeholder text + tag table. */
function renderBlock(text, tags) {
  let out = '';
  let last = 0;
  let m;
  const re = /<(\/?)(\d+)(\/?)>/g;
  while ((m = re.exec(text))) {
    out += escHtml(text.slice(last, m.index));
    const pair = tags[Number(m[2])];
    if (pair) {
      const [open, close] = pair;
      out += m[3] === '/' ? open : m[1] === '/' ? (close ?? '') : open;
    }
    last = m.index + m[0].length;
  }
  return out + escHtml(text.slice(last));
}

/** English page path ("" = home) → localised URL. */
const localeUrl = (lang, slug) => (slug ? `${BASE}/${lang}/${slug}` : `${BASE}/${lang}`);
const englishUrl = (slug) => (slug ? `${BASE}/${slug}` : `${BASE}/`);

/**
 * Rewrites one attribute on the first tag matching `test`, leaving the rest of the
 * tag byte-identical. Attribute ORDER is not assumed: the Astro build emits
 * `<link href="…" rel="canonical">`, i.e. href first, so order-dependent patterns
 * silently matched nothing.
 */
function rewriteAttr(html, tagRe, test, attrName, newValue, name, report) {
  let matched = false;
  const out = html.replace(tagRe, (tag) => {
    const attrs = Object.fromEntries([...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
    if (!test(attrs)) return tag;
    matched = true;
    const re = new RegExp(`(\\s${attrName}=")[^"]*(")`);
    return re.test(tag) ? tag.replace(re, `$1${newValue}$2`) : tag;
  });
  if (!matched) report.misses.add(name);
  return out;
}

/**
 * Locale identity fixes applied after text substitution. Each rule reports whether it
 * matched, so a template change cannot silently turn one into a no-op.
 */
function applyLocaleIdentity(html, lang, slug, report) {
  const url = localeUrl(lang, slug);
  const enUrl = englishUrl(slug);
  const row = BY_PATH[lang];
  let out = html;

  // <html … lang="en" dir="ltr"> → locale. The build already emits dir, so RTL
  // locales must REPLACE its value rather than add a second attribute.
  const before = out;
  out = out.replace(/<html[^>]*>/, (tag) => {
    let t = tag.replace(/(\slang=")[^"]*(")/, `$1${row.hreflang}$2`);
    t = t.replace(/(\sdir=")[^"]*(")/, `$1${RTL.has(lang) ? 'rtl' : 'ltr'}$2`);
    return t;
  });
  if (out === before) report.misses.add('html-lang');

  // Canonical → this page, no trailing slash (audit H5: the proxy emitted /es/,
  // which 301s back to /es and contradicts the sitemap).
  out = rewriteAttr(out, /<link[^>]*>/g, (a) => a.rel === 'canonical', 'href', url, 'canonical', report);

  // hreflang en + x-default must point at the ENGLISH page, not at self
  // (audit C2 — one defect repeated across ~13,035 URLs).
  out = rewriteAttr(
    out,
    /<link[^>]*>/g,
    (a) => a.hreflang === 'x-default',
    'href',
    enUrl,
    'hreflang-x-default',
    report
  );
  out = rewriteAttr(out, /<link[^>]*>/g, (a) => a.hreflang === 'en', 'href', enUrl, 'hreflang-en', report);

  out = rewriteAttr(out, /<meta[^>]*>/g, (a) => a.property === 'og:url', 'content', url, 'og-url', report);
  out = rewriteAttr(
    out,
    /<meta[^>]*>/g,
    (a) => a.property === 'og:locale',
    'content',
    row.hreflang,
    'og-locale',
    report
  );

  // LanguagePicker: the trigger shows the current language and the matching option is
  // marked current. Both are per-locale, so the component ships English and gets
  // rewritten here. Soft rules — silent while the picker is not yet mounted, but a
  // miss is reported once its marker attribute is present.
  // Global flags matter: Header.astro mounts the picker twice (mobile bar + desktop bar),
  // so a first-match-only replace would leave the second one reading "English".
  if (out.includes('data-i18n-current-lang')) {
    const beforeLabel = out;
    out = out.replace(/(<span[^>]*\sdata-i18n-current-lang[^>]*>)[^<]*(<\/span>)/g, `$1${row.nativeLabel}$2`);
    if (out === beforeLabel) report.misses.add('picker-current-label');
  }
  if (out.includes('data-i18n-lang=')) {
    const beforeCurrent = out;
    out = out.replace(new RegExp(`(<a\\b[^>]*\\sdata-i18n-lang="${row.hreflang}")`, 'g'), '$1 aria-current="true"');
    if (out === beforeCurrent) report.misses.add('picker-aria-current');
  }

  // JSON-LD identity (audit C3): @id collided across every locale, url pointed at the
  // English home page and inLanguage claimed "en" on all translated pages.
  //
  // Only WebPage-ish nodes are localised. Organization.url is the company's canonical
  // URL — the same entity in every language — and on the home page it equals the English
  // root, so a blanket url rewrite would wrongly relocalise it.
  // Page-level types get THIS page's URL. WebSite describes the site as a whole, so it
  // gets the locale root — giving it the page URL would claim the site itself lives at
  // /es/about. Organization is one entity across all languages: left alone entirely.
  const PAGE_TYPES = new Set(['WebPage', 'CollectionPage', 'ItemPage', 'AboutPage', 'FAQPage', 'ContactPage']);
  const localeRoot = `${BASE}/${lang}`;
  out = out.replace(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g, (full, body) => {
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      return full; // leave anything we cannot parse exactly as it was
    }
    const walk = (node) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== 'object') return;
      if (typeof node.inLanguage === 'string') node.inLanguage = row.hreflang;
      if (typeof node['@id'] === 'string' && node['@id'].endsWith('#webpage')) node['@id'] = `${url}#webpage`;
      const types = [].concat(node['@type'] ?? []);
      if (typeof node.url === 'string') {
        if (types.includes('WebSite')) node.url = localeRoot;
        else if (types.some((t) => PAGE_TYPES.has(t))) node.url = url;
      }
      for (const v of Object.values(node)) if (v && typeof v === 'object') walk(v);
    };
    walk(data);
    return `<script type="application/ld+json">${JSON.stringify(data)}</script>`;
  });

  // Internal links → locale-prefixed. Only same-origin document links; asset paths
  // (/_astro/, images, xml, ico) and anchors stay put.
  out = out.replace(/(<a\b[^>]*?\shref=")\/([^"#?]*)("|[#?])/g, (m, pre, path, tail) => {
    if (/^(_astro|assets|images|fonts|favicon|robots|sitemap)/.test(path)) return m;
    if (/\.(xml|txt|ico|png|jpe?g|webp|svg|css|js|json|pdf)$/i.test(path)) return m;
    // href="/" is the home link: it must become "/es", not "/es/". The trailing-slash
    // form 301-redirects back (deploy/Caddyfile.docker), which would put a needless
    // redirect hop on the logo of every localised page — and contradict the
    // no-trailing-slash canonical this build emits (audit H5).
    if (path === '') return `${pre}/${lang}${tail}`;
    return `${pre}/${lang}/${path}${tail}`;
  });

  // Attribution last, so it cannot shift any offset the substitution relied on.
  out = applyPageMarkers(out, row, report);
  out = applyVisibleLink(out, report);

  return out;
}

// ── Build ────────────────────────────────────────────────────────────────────

const segFiles = readdirSync(SEG_DIR).filter((f) => f.endsWith('.json'));
if (segFiles.length === 0) {
  console.error('i18n/segments/ is empty. Run: node scripts/i18n/extract.mjs');
  process.exit(1);
}

/**
 * The page set is SITEMAP_SLUGS, not "whatever is in dist/". dist/ also holds pages
 * that must never be localised — the Decap CMS admin shell (no lang attribute, no
 * content) and 404.html. Driving the build off the sitemap is also what makes the
 * URL-parity gate meaningful: 237 slugs × N locales, no more and no less.
 */
const SITEMAP_SLUGS = getPages();

/** page key (as written by extract.mjs) → segment file */
const segByPage = new Map();
for (const f of segFiles) {
  const parsed = JSON.parse(readFileSync(join(SEG_DIR, f), 'utf8'));
  segByPage.set(parsed.page, parsed);
}

const targets = [];
const missingSource = [];
for (const slug of SITEMAP_SLUGS) {
  const key = slug === '' ? 'index' : slug;
  const entry = segByPage.get(key);
  if (!entry) missingSource.push(slug || '(home)');
  else targets.push({ slug, ...entry });
}
if (missingSource.length) {
  console.error(
    `${missingSource.length} sitemap slug(s) have no built English page: ${missingSource.slice(0, 10).join(', ')}`
  );
  process.exit(1);
}
console.log(
  `localising ${targets.length} slugs × ${LANGS.length} locale(s) = ${(targets.length * LANGS.length).toLocaleString()} pages\n`
);

let builtPages = 0;

/**
 * Every monetary amount seen, across every locale, written to i18n/locale-format.json.
 *
 * This is the deliberate answer to "does it convert currency?" — no, and here is the
 * list so you can decide per market. A price is a commercial commitment; a build script
 * is the wrong thing to be making one on your behalf at a rate it cannot check.
 */
const moneyFindings = [];

for (const lang of LANGS) {
  const tmFile = join(TM_DIR, `${lang}.json`);
  if (!existsSync(tmFile)) {
    console.error(`No translation memory for "${lang}". Run: node scripts/i18n/translate.mjs --lang ${lang}`);
    process.exit(1);
  }
  const tm = JSON.parse(readFileSync(tmFile, 'utf8'));

  // A stale locale directory would leave orphan pages behind after a slug is removed.
  rmSync(join(DIST, lang), { recursive: true, force: true });

  const report = { pages: 0, replaced: 0, untranslated: 0, misses: new Set() };
  const INTL_TAG = intlLocale(BY_PATH[lang]);
  let formatCount = 0;

  for (const target of targets) {
    const { slug, file, segments } = target;
    const source = join(ROOT, file);
    if (!existsSync(source)) continue;

    let html = readFileSync(source, 'utf8');

    // Right-to-left: segments are already sorted descending, so earlier offsets stay valid.
    for (const seg of segments) {
      const translated = tm[seg.hash];
      if (translated === undefined) {
        report.untranslated++;
        continue;
      }
      // Locale conventions are applied HERE, not in the model: rule 4 of the translation
      // prompt tells the model to leave numbers alone precisely so this step can rewrite
      // their presentation deterministically. Values are never changed — see
      // format-locale.mjs for why currency conversion is permanently out of scope.
      let localized = translated;
      if (LOCALE_FORMAT.enabled) {
        const formatted = formatText(translated, INTL_TAG, LOCALE_FORMAT);
        localized = formatted.text;
        formatCount += formatted.changes.length;
        for (const m of formatted.money) {
          moneyFindings.push({ page: slug || '(home)', currency: m.currency, value: m.value, wrote: m.wrote });
        }
      }

      let replacement;
      if (seg.kind === 'block') replacement = renderBlock(localized, seg.tags ?? []);
      else if (seg.kind === 'jsonld') replacement = escJson(localized);
      else if (seg.kind.startsWith('attr:')) replacement = escAttr(localized);
      else replacement = escHtml(localized);

      html = html.slice(0, seg.start) + replacement + html.slice(seg.end);
      report.replaced++;
    }

    html = applyLocaleIdentity(html, lang, slug, report);

    const outPath = slug ? join(DIST, lang, slug, 'index.html') : join(DIST, lang, 'index.html');
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, html);
    report.pages++;
  }

  console.log(
    `${lang}: ${report.pages} pages, ${report.replaced.toLocaleString()} segments replaced, ` +
      `${report.untranslated.toLocaleString()} left in English`
  );
  if (LOCALE_FORMAT.enabled && formatCount) {
    console.log(`  ${formatCount.toLocaleString()} number/currency/percent forms rewritten for ${INTL_TAG}`);
  }
  if (report.misses.size) {
    console.log(`  ⚠ identity rules that matched nothing: ${[...report.misses].join(', ')}`);
  }
  builtPages += report.pages;
}

// Disclosed at the point of action, not buried in a README: this is what the pages
// now carry, and which key removes it.
if (LOCALE_FORMAT.enabled) {
  const byCurrency = {};
  for (const m of moneyFindings) byCurrency[m.currency] = (byCurrency[m.currency] ?? 0) + 1;
  writeFileSync(
    join(I18N_DIR, 'locale-format.json'),
    JSON.stringify({ counts: byCurrency, total: moneyFindings.length, findings: moneyFindings }, null, 2)
  );
  if (moneyFindings.length) {
    const summary = Object.entries(byCurrency).map(([c, n]) => `${n} ${c}`).join(', ');
    console.log(
      `\n\u2139 ${moneyFindings.length.toLocaleString()} monetary amount(s) reformatted, never converted (${summary}).` +
        `\n  Values are unchanged in every locale. Review i18n/locale-format.json to decide` +
        `\n  whether any market needs a different price — this pipeline will not guess one.`
    );
  }
}

const attrBytes = markerBytes(BY_PATH[LANGS[0]]);
if (attrBytes) {
  console.log(
    `\n${builtPages.toLocaleString()} pages written \u00b7 each carries ${attrBytes} bytes of ` +
      `ConveyThis attribution (0 requests, 0 layout shift; disable with credit.generatorTag / credit.htmlComment)`
  );
}
