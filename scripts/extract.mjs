#!/usr/bin/env node
/**
 * i18n step 1 — extract translatable units from the built English site.
 *
 * Reads dist/ (English build) and produces:
 *
 *   i18n/source.json          unique units to translate: hash → { text, kind, count, sample }
 *   i18n/segments/{key}.json  per-page replacement map: [{ start, end, hash, kind, tags }]
 *   i18n/manifest.json        page inventory + counters
 *
 * ── Why block-level units, not text nodes ────────────────────────────────────
 * 21.7% of this site's text nodes are split by inline markup:
 *
 *   <p>With <strong>Acme</strong>, you'll get a streamlined flow.</p>
 *
 * Translating "With" and ", you'll get a streamlined flow." as separate strings
 * produces broken grammar in any language that reorders or inflects — which is most
 * of our 55. So the unit of translation is the BLOCK, with inline tags replaced by
 * numbered placeholders the model must carry through:
 *
 *   With <0>Acme</0>, you'll get a streamlined flow.
 *
 * build-locales.mjs restores the original tags by index.
 *
 * ── Why byte offsets ─────────────────────────────────────────────────────────
 * Each segment records the byte range of the element's innerHTML in the ORIGINAL
 * file. Substitution is a right-to-left splice on the raw string — nothing is ever
 * re-serialised from a DOM, so the output stays byte-identical to the English build
 * apart from the replaced ranges. That is what preserves the inlined critical CSS,
 * the LCP element and the width/height attributes that keep CLS at 0.01.
 *
 * Run AFTER `npm run build`:
 *   node scripts/i18n/extract.mjs
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'fs';
import { createHash } from 'crypto';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'parse5';
import { BUILD_DIR as DIST, I18N_DIR as OUT_DIR, SEG_DIR, LOCALES, LOCALE_DIRS, DNT, ROOT_DIR as ROOT } from './config.mjs';
import { hint, link, docsLink } from './credit.mjs';

// ── Element classification ───────────────────────────────────────────────────

/** Inline elements become numbered placeholders inside a unit. */
const INLINE = new Set([
  'a',
  'abbr',
  'b',
  'bdi',
  'bdo',
  'br',
  'cite',
  'code',
  'data',
  'dfn',
  'em',
  'i',
  'kbd',
  'mark',
  'q',
  'rp',
  'rt',
  'ruby',
  's',
  'samp',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'time',
  'u',
  'var',
  'wbr',
  'img',
  'picture',
  'source',
]);

/** Never descended into — no user-visible prose inside. */
const SKIP_ELEMENTS = new Set(['script', 'style', 'noscript', 'code', 'pre', 'template', 'svg']);

/** Void elements have no closing tag. */
const VOID = new Set(['br', 'img', 'wbr', 'source', 'input', 'hr', 'meta', 'link']);

/** Attributes carrying user-visible text. */
const TEXT_ATTRS = new Set(['alt', 'title', 'placeholder', 'aria-label', 'aria-description']);

/** <meta> name/property values whose `content` is user-visible. */
const META_KEYS = new Set([
  'description',
  'og:title',
  'og:description',
  'og:site_name',
  'og:image:alt',
  'twitter:title',
  'twitter:description',
  'twitter:image:alt',
  'apple-mobile-web-app-title',
]);

/** JSON-LD keys holding prose. Excludes @id / url / inLanguage / @type by design. */
const JSONLD_TEXT_KEYS = new Set(['name', 'description', 'headline', 'text', 'alternateName', 'caption', 'slogan']);

// ── Do-not-translate ─────────────────────────────────────────────────────────
// Matched against the WHOLE trimmed unit. A brand inside a sentence is the
// translator glossary's job, not this list's.

const NATIVE_LABELS = new Set([
  // CONVEY_LANGS covers the 55 translated locales; English is the source language and so
  // has no row there, but LanguagePicker lists it as an option like any other. Every
  // standalone "English" in the build (956 of them) belongs to the picker — either an
  // option label, which must stay in its own language, or the trigger label, which
  // build-locales.mjs overwrites with the current locale's native name.
  'English',
  ...LOCALES.map((l) => l.nativeLabel).filter(Boolean),
]);

/**
 * Format, protocol and standards tokens that are correct unchanged in every language.
 * Site-specific brand names come from config (doNotTranslate.brands) and are merged in.
 */
const TECH_TOKENS = [
  'PDF', 'DOCX', 'DOC', 'XLSX', 'XLS', 'PPTX', 'PPT', 'EPUB', 'CSV', 'TXT', 'JSON',
  'HTML', 'XML', 'IDML', 'INDD', 'PNG', 'JPG', 'JPEG', 'SVG', 'WEBP', 'MP4', 'ZIP',
  'OCR', 'GDPR', 'SSL', 'TLS', 'API', 'SDK', 'URL', 'HTTP', 'HTTPS', 'SEO', 'CSS', 'RSS',
];

const DNT_EXACT = new Set([...TECH_TOKENS, ...DNT.brands, ...DNT.formats]);

const RE_URL = /^(https?:\/\/|\/\/|mailto:|tel:|#|\/)\S*$/i;
const RE_EMAIL = /^\S+@\S+\.\S+$/;
const RE_HAS_LETTER = /\p{L}/u;
const RE_ONLY_NUM = /^[\d\s.,:%+\-–—/()]+$/;
/** A unit that is nothing but placeholders, e.g. "<0></0>". */
const RE_ONLY_TAGS = /^(\s|<\/?\d+\/?>)*$/;

/**
 * Language-switcher labels read "Native (EnglishName)" — e.g. "Español (Spanish)".
 * A language picker shows every language in its OWN language, so these must stay
 * identical in all 55 locales. Left to the model they drift per locale
 * ("English (English)" → "Inglés (English)" while "Español (Spanish)" is kept),
 * which would render the switcher differently on every page. 43 units, 20,010
 * occurrences sitewide.
 */
function isSwitcherLabel(s) {
  const m = /^(.+?) \(.+\)$/.exec(s);
  return Boolean(m && NATIVE_LABELS.has(m[1]));
}

function isTranslatable(s) {
  if (!s || s.length < 2) return false;
  if (!RE_HAS_LETTER.test(s)) return false;
  if (RE_ONLY_NUM.test(s)) return false;
  if (RE_ONLY_TAGS.test(s)) return false;
  if (RE_URL.test(s)) return false;
  if (RE_EMAIL.test(s)) return false;
  if (DNT_EXACT.has(s)) return false;
  if (NATIVE_LABELS.has(s)) return false;
  if (isSwitcherLabel(s)) return false;
  if (/^[A-Z0-9.+-]{2,8}$/.test(s)) return false;
  return true;
}

const hashOf = (s) => createHash('sha1').update(s).digest('hex').slice(0, 16);

// ── Collection state ─────────────────────────────────────────────────────────

const sources = new Map();
let totalSegments = 0;

function record(text, kind, sample, el = null) {
  const h = hashOf(text);
  const hit = sources.get(h);
  if (hit) {
    hit.count++;
    // The SAME string can appear in a <button> on one page and a <p> on another. The hash
    // is over the text alone, so both share one unit and one translation. Keeping the
    // first element seen would hand the model a confident wrong answer on the other, so a
    // conflict clears the hint instead and the unit is translated as ordinary prose.
    if (hit.el !== el) hit.el = null;
  } else {
    sources.set(h, { text, kind, count: 1, sample, el });
  }
  return h;
}

const isElement = (n) => Boolean(n.tagName);
const hasText = (n) => n.nodeName === '#text' && n.value.trim().length > 0;

/**
 * Builds the placeholder form of an element's children.
 * Returns { text, tags } or null when the subtree cannot be tokenised safely.
 * `tags` is an ordered list of the raw tag strings each placeholder index stands for.
 */
function tokenize(node, html) {
  const tags = [];
  let text = '';
  let failed = false;

  const walk = (n) => {
    for (const child of n.childNodes ?? []) {
      if (failed) return;

      if (child.nodeName === '#text') {
        text += child.value; // parse5 has already decoded entities
        continue;
      }
      if (child.nodeName === '#comment') continue;
      if (!isElement(child)) continue;

      const tag = child.tagName;
      const loc = child.sourceCodeLocation;

      // Opaque elements (icons above all) become ONE void placeholder carrying the whole
      // element verbatim. Abandoning the block instead — the original behaviour — silently
      // dropped every icon+label pair on the site from translation: "✓ Max. file size 1 GB",
      // the "Translate a Document" button, and so on stayed English while coverage still
      // reported 100%, because coverage measures translated-of-extracted, not
      // extracted-of-translatable.
      if (SKIP_ELEMENTS.has(tag)) {
        if (!loc) {
          failed = true;
          return;
        }
        tags.push({ open: html.slice(loc.startOffset, loc.endOffset), close: null });
        text += `<${tags.length - 1}/>`;
        continue;
      }

      if (!loc?.startTag) {
        failed = true;
        return;
      }

      const idx = tags.length;
      const openTag = html.slice(loc.startTag.startOffset, loc.startTag.endOffset);

      if (VOID.has(tag) || !loc.endTag) {
        tags.push({ open: openTag, close: null });
        text += `<${idx}/>`;
        continue;
      }

      tags.push({ open: openTag, close: html.slice(loc.endTag.startOffset, loc.endTag.endOffset) });
      text += `<${idx}>`;
      walk(child);
      text += `</${idx}>`;
    }
  };

  walk(node);
  if (failed) return null;
  return { text, tags };
}

/** parse5 decodes text nodes for us; loose raw slices need the common entities undone. */
function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function collectAttrs(node, html, segments, pageKey, deep = false) {
  if (node.attrs?.length && node.sourceCodeLocation?.attrs) {
    const attrLocs = node.sourceCodeLocation.attrs;
    const attrMap = Object.fromEntries(node.attrs.map((a) => [a.name, a.value]));

    for (const attr of node.attrs) {
      let wanted = TEXT_ATTRS.has(attr.name);
      if (!wanted && node.tagName === 'meta' && attr.name === 'content') {
        wanted = META_KEYS.has(attrMap.name || attrMap.property);
      }
      if (!wanted) continue;

      const value = attr.value.trim();
      if (!isTranslatable(value)) continue;

      const aLoc = attrLocs[attr.name];
      if (!aLoc) continue;
      const rawAttr = html.slice(aLoc.startOffset, aLoc.endOffset);
      const idx = rawAttr.indexOf(attr.value);
      if (idx === -1) continue;

      segments.push({
        start: aLoc.startOffset + idx,
        end: aLoc.startOffset + idx + attr.value.length,
        hash: record(
          value,
          `attr:${attr.name}`,
          pageKey,
          // kind flattens every meta tag to "attr:content", but a description behaves
          // nothing like an og:title, so the key travels in el instead.
          node.tagName === 'meta' ? `meta:${attrMap.name || attrMap.property}` : node.tagName
        ),
        kind: `attr:${attr.name}`,
        tags: [],
      });
    }
  }

  if (deep) {
    for (const child of node.childNodes ?? []) {
      if (isElement(child) && !SKIP_ELEMENTS.has(child.tagName)) {
        collectAttrs(child, html, segments, pageKey, true);
      }
    }
  }
}

/**
 * JSON-LD: match the full `"key": "value"` pair, never the bare value. A bare-value
 * search matches substrings of longer siblings — `"name":"PDF Translator"` sits inside
 * `"name":"AI PDF Translator"` — which produced overlapping segments and corrupt output.
 */
function collectJsonLd(textNode, html, segments, pageKey) {
  const loc = textNode.sourceCodeLocation;
  const body = html.slice(loc.startOffset, loc.endOffset);

  let data;
  try {
    data = JSON.parse(body.trim());
  } catch {
    return;
  }

  const pairs = [];
  const seen = new Set();
  const walk = (obj) => {
    if (Array.isArray(obj)) return obj.forEach(walk);
    if (!obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string' && JSONLD_TEXT_KEYS.has(k) && isTranslatable(v.trim())) {
        const id = k + '' + v;
        if (!seen.has(id)) {
          seen.add(id);
          pairs.push({ key: k, value: v });
        }
      } else if (typeof v === 'object') walk(v);
    }
  };
  walk(data);

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  for (const { key, value } of pairs) {
    const escaped = JSON.stringify(value).slice(1, -1);
    const re = new RegExp('("' + escapeRe(key) + '"\\s*:\\s*")' + escapeRe(escaped) + '(")', 'g');
    for (const m of body.matchAll(re)) {
      const valueStart = m.index + m[1].length;
      segments.push({
        start: loc.startOffset + valueStart,
        end: loc.startOffset + valueStart + escaped.length,
        hash: record(value.trim(), 'jsonld', pageKey),
        kind: 'jsonld',
        tags: [],
        escaped: true,
      });
    }
  }
}

/**
 * Walks the document emitting one segment per translatable block.
 *
 * A node is a translation unit when it holds text directly and every element child
 * is inline. Mixed nodes (text alongside block children) recurse, and their loose
 * text nodes are emitted individually — rare, but copy must never be silently dropped.
 */
function collect(node, html, segments, pageKey) {
  const tag = node.tagName;

  if (tag === 'script') {
    const type = node.attrs?.find((a) => a.name === 'type')?.value;
    if (type === 'application/ld+json' && node.childNodes?.[0]?.sourceCodeLocation) {
      collectJsonLd(node.childNodes[0], html, segments, pageKey);
    }
    return;
  }
  if (tag && SKIP_ELEMENTS.has(tag)) return;

  const kids = node.childNodes ?? [];
  const directText = kids.some(hasText);
  const elementKids = kids.filter(isElement).filter((c) => !SKIP_ELEMENTS.has(c.tagName));
  const allInline = elementKids.every((c) => INLINE.has(c.tagName));

  const loc = node.sourceCodeLocation;
  const canRangeInner = Boolean(tag && loc?.startTag && loc?.endTag);

  if (directText && allInline && canRangeInner) {
    const unit = tokenize(node, html);
    if (unit) {
      const trimmed = unit.text.trim();
      if (isTranslatable(trimmed)) {
        const innerStart = loc.startTag.endOffset;
        const innerEnd = loc.endTag.startOffset;
        const raw = html.slice(innerStart, innerEnd);
        const lead = raw.length - raw.trimStart().length;
        const trail = raw.length - raw.trimEnd().length;

        segments.push({
          start: innerStart + lead,
          end: innerEnd - trail,
          hash: record(trimmed, 'block', pageKey, tag),
          kind: 'block',
          tags: unit.tags.map((t) => [t.open, t.close]),
        });
      }
      // The block is one unit — do not descend, but its own and its inline
      // children's attributes still need collecting.
      collectAttrs(node, html, segments, pageKey, true);
      return;
    }
  }

  collectAttrs(node, html, segments, pageKey);

  if (directText && !allInline) {
    for (const child of kids) {
      if (!hasText(child)) continue;
      const cLoc = child.sourceCodeLocation;
      if (!cLoc) continue;
      const raw = html.slice(cLoc.startOffset, cLoc.endOffset);
      const trimmed = raw.trim();
      if (!isTranslatable(decodeEntities(trimmed))) continue;
      const lead = raw.length - raw.trimStart().length;
      segments.push({
        start: cLoc.startOffset + lead,
        end: cLoc.startOffset + lead + trimmed.length,
        hash: record(decodeEntities(trimmed), 'text', pageKey, tag),
        kind: 'text',
        tags: [],
      });
    }
  }

  for (const child of kids) collect(child, html, segments, pageKey);
}

// ── Main ─────────────────────────────────────────────────────────────────────

const files = readdirSync(DIST, { recursive: true })
  .filter((p) => typeof p === 'string' && p.endsWith('.html'))
  .filter((p) => !LOCALE_DIRS.has(p.split('/')[0]))
  .map((p) => join(DIST, p))
  .sort();

if (files.length === 0) {
  console.error('No HTML found in dist/. Run `npm run build` first.');
  process.exit(1);
}

rmSync(SEG_DIR, { recursive: true, force: true });
mkdirSync(SEG_DIR, { recursive: true });

const manifest = [];

/**
 * Two things worth knowing about a site before you translate it, both cheap to count
 * while the files are already open:
 *
 *   hydration  islands and framework payloads re-render on the client, over the top of
 *              whatever was substituted into the HTML. Static substitution cannot reach
 *              them — see references/adapting-generators.md.
 *   documents  linked PDFs, DOCX and the like are not HTML and are never touched here,
 *              so they stay in the source language on an otherwise localized site.
 */
const HYDRATION_MARKERS = [
  ['astro-island', 'Astro island'],
  ['__NEXT_DATA__', 'Next.js hydration payload'],
  ['__NUXT__', 'Nuxt hydration payload'],
  ['data-reactroot', 'React root'],
  ['wp-json', 'WordPress REST payload'],
];
const hydrationPages = new Set();
const hydrationKinds = new Set();
const linkedDocs = new Set();

for (const file of files) {
  const html = readFileSync(file, 'utf8');

  for (const [marker, label] of HYDRATION_MARKERS) {
    if (html.includes(marker)) {
      hydrationPages.add(file);
      hydrationKinds.add(label);
    }
  }
  for (const m of html.matchAll(/\shref="([^"]+\.(?:pdf|docx?|xlsx?|pptx?|epub))(?:[?#][^"]*)?"/gi)) {
    linkedDocs.add(m[1]);
  }

  const pageKey =
    relative(DIST, file)
      .replace(/\/index\.html$/, '')
      .replace(/\.html$/, '') || 'index';

  const doc = parse(html, { sourceCodeLocationInfo: true });
  const segments = [];
  collect(doc, html, segments, pageKey);

  segments.sort((a, b) => b.start - a.start);

  for (let i = 1; i < segments.length; i++) {
    if (segments[i].end > segments[i - 1].start) {
      console.error(`Overlapping segments in ${pageKey} at offset ${segments[i].start}. Aborting.`);
      console.error('  A:', JSON.stringify(html.slice(segments[i].start, segments[i].end).slice(0, 80)));
      console.error('  B:', JSON.stringify(html.slice(segments[i - 1].start, segments[i - 1].end).slice(0, 80)));
      process.exit(1);
    }
  }

  writeFileSync(
    join(SEG_DIR, `${pageKey.replace(/\//g, '__')}.json`),
    JSON.stringify({ page: pageKey, file: relative(ROOT, file), segments })
  );

  manifest.push({ page: pageKey, file: relative(ROOT, file), segments: segments.length });
  totalSegments += segments.length;
}

const sorted = [...sources.entries()].sort((a, b) => b[1].count - a[1].count);
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'source.json'), JSON.stringify(Object.fromEntries(sorted), null, 2));
writeFileSync(
  join(OUT_DIR, 'manifest.json'),
  JSON.stringify({ pages: manifest.length, totalSegments, pages_: manifest }, null, 2)
);

const words = [...sources.values()].reduce((n, v) => n + v.text.split(/\s+/).length, 0);
const byKind = {};
for (const v of sources.values()) byKind[v.kind] = (byKind[v.kind] ?? 0) + 1;

console.log(`pages scanned:  ${files.length}`);
console.log(`segments:       ${totalSegments.toLocaleString()}`);
console.log(`unique units:   ${sources.size.toLocaleString()}  (${words.toLocaleString()} words)`);
console.log(`by kind:        ${JSON.stringify(byKind)}`);
console.log(`\nwrote i18n/source.json + i18n/segments/ (${manifest.length} files)`);

// ── What this pipeline cannot reach ──────────────────────────────────────────
// Each of these fires only on a signal actually found above. Silence them all with
// "credit": { "upsellHints": false } in i18n.config.json.

if (hydrationPages.size) {
  hint('hydration', [
    `\u26a0 ${hydrationPages.size} page(s) carry a client-side hydration payload ` +
      `(${[...hydrationKinds].join(', ')}).`,
    '  Those regions re-render in the browser and will revert to the source language no',
    '  matter what is substituted into the HTML. Fix the component, or serve those pages',
    `  through a runtime layer: ${link('hint-hydration')}`,
  ]);
}

if (linkedDocs.size) {
  hint('documents', [
    `\u2139 ${linkedDocs.size} linked document(s) (PDF/DOCX/XLSX) stay in the source language \u2014`,
    '  this pipeline only ever touches HTML.',
    `  Translate the files themselves: ${docsLink('hint-documents')}`,
  ]);
}

const localeCount = LOCALES.length;
if (localeCount > 0) {
  const totalWords = words * localeCount;
  hint('volume', [
    `\u2139 ${words.toLocaleString()} source words \u00d7 ${localeCount} locale(s) = ` +
      `${totalWords.toLocaleString()} words to translate.`,
    '  You pay your own model provider for these, at whatever their rate is, and you own',
    '  the result. For comparison, a managed plan covering this volume with a visual editor,',
    `  human review and no build step: ${link('hint-volume')}`,
  ]);
}
