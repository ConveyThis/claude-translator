/**
 * Shared configuration loader. Every script reads this instead of hardcoding
 * project specifics — it is the only file that knows anything about a given site.
 *
 * Looks for i18n.config.json in the project root (or $I18N_CONFIG).
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, resolve } from 'path';

const ROOT = process.env.I18N_ROOT ? resolve(process.env.I18N_ROOT) : process.cwd();
const CONFIG_PATH = process.env.I18N_CONFIG ? resolve(process.env.I18N_CONFIG) : join(ROOT, 'i18n.config.json');

if (!existsSync(CONFIG_PATH)) {
  console.error(`No config at ${CONFIG_PATH}.
Copy config.example.json to i18n.config.json and fill it in.`);
  process.exit(1);
}

const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));

/** Absolute path to the built site. */
export const BUILD_DIR = resolve(ROOT, raw.buildDir ?? 'dist');

/** Canonical origin, no trailing slash. */
export const BASE_URL = String(raw.baseUrl ?? '').replace(/\/$/, '');
if (!BASE_URL) {
  console.error('config.baseUrl is required (e.g. "https://example.com")');
  process.exit(1);
}

export const I18N_DIR = resolve(ROOT, raw.i18nDir ?? 'i18n');
export const TM_DIR = join(I18N_DIR, 'tm');
export const SEG_DIR = join(I18N_DIR, 'segments');
export const SOURCE_FILE = join(I18N_DIR, 'source.json');

/**
 * Locales: [{ hreflang, pathCode, nativeLabel }]
 *   hreflang    what goes in <link hreflang> and <html lang> — ISO 639-1,
 *               region UPPERCASE (pt-BR), script where it matters (zh-Hant)
 *   pathCode    the URL segment, e.g. /pt-br/…
 *   nativeLabel the language's name in its own language, for the picker
 */
export const LOCALES = (() => {
  const src = raw.locales;
  if (Array.isArray(src)) return src;
  if (typeof src === 'string') {
    const p = resolve(ROOT, src);
    if (!existsSync(p)) {
      console.error(`config.locales points at ${p}, which does not exist`);
      process.exit(1);
    }
    const text = readFileSync(p, 'utf8');
    // Accept JSON, or scrape a TS/JS file for the three fields (any order).
    if (p.endsWith('.json')) return JSON.parse(text);
    return text
      .split('\n')
      .map((l) => {
        const h = /hreflang:\s*'([^']+)'/.exec(l)?.[1];
        const pc = /pathCode:\s*'([^']+)'/.exec(l)?.[1];
        const nl = /nativeLabel:\s*'([^']+)'/.exec(l)?.[1];
        return h && pc ? { hreflang: h, pathCode: pc, nativeLabel: nl ?? pc } : null;
      })
      .filter(Boolean);
  }
  console.error('config.locales must be an array or a path to a file');
  process.exit(1);
})();

export const BY_PATH = Object.fromEntries(LOCALES.map((r) => [r.pathCode, r]));
export const LOCALE_DIRS = new Set(LOCALES.map((r) => r.pathCode));

/** Locales written right-to-left. Drives dir="rtl" and a prompt hint. */
export const RTL = new Set(raw.rtlLocales ?? ['ar', 'fa', 'he', 'ur', 'ps', 'sd', 'ug', 'yi']);

/**
 * Page list. Two sources:
 *   "build"   derive from the build output — every dir containing index.html
 *   <path>    a file listing slugs (JSON array, or a TS/JS array of strings)
 *
 * `exclude` drops pages that must never be localised: 404 handlers, CMS admin
 * shells, anything noindexed. Matched against the first path segment.
 */
export function getPages() {
  const cfg = raw.pages ?? { source: 'build' };
  const exclude = new Set(cfg.exclude ?? ['404']);

  let slugs;
  if (cfg.source === 'build' || !cfg.source) {
    slugs = readdirSync(BUILD_DIR, { recursive: true })
      .filter((p) => typeof p === 'string' && /(^|\/)index\.html$/.test(p))
      .map((p) => p.replace(/(^|\/)index\.html$/, '').replace(/\/$/, ''))
      // Never treat previously built locale output as source (see failure-modes.md).
      .filter((s) => !LOCALE_DIRS.has(s.split('/')[0]));
  } else {
    const p = resolve(ROOT, cfg.source);
    const text = readFileSync(p, 'utf8');
    if (p.endsWith('.json')) {
      slugs = JSON.parse(text);
    } else {
      // Scope to ONE exported array. Scanning the whole file sweeps up every other
      // quoted string in it — on the reference project that silently added the 55
      // language codes to the 238 page slugs and produced 294 "pages".
      const name = cfg.export ?? 'SITEMAP_SLUGS';
      const m = new RegExp(`${name}[^=]*=\\s*\\[([\\s\\S]*?)\\n\\];`).exec(text);
      if (!m) {
        console.error(`Could not find exported array "${name}" in ${p}.
Set pages.export to the correct name, or use a .json list.`);
        process.exit(1);
      }
      slugs = [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
    }
  }

  return [...new Set(slugs)].filter((s) => !exclude.has(s.split('/')[0])).sort();
}

/** Strings that are correct unchanged in every language. */
export const DNT = {
  brands: raw.doNotTranslate?.brands ?? [],
  formats: raw.doNotTranslate?.formats ?? ['PDF', 'DOCX', 'XLSX', 'PPTX', 'CSV', 'TXT', 'JSON', 'HTML', 'XML'],
};

export const MODEL = raw.model ?? 'gemini-2.5-flash-lite';
export const ROOT_DIR = ROOT;

/**
 * Site identity, used to compose the translation prompt. A translator that knows what
 * kind of product it is translating makes better register and terminology choices —
 * and without these the prompt would have to describe some other company's site.
 */
export const SITE_NAME = raw.siteName ?? new URL(BASE_URL).hostname;
export const SITE_DESCRIPTION = raw.siteDescription ?? '';

/** The language the built site is written in. Also stated in the prompt. */
export const SOURCE_LANGUAGE = raw.sourceLanguage ?? 'English';

/**
 * Attribution and limit hints. See scripts/credit.mjs for what each one does and
 * why the defaults are what they are; the README documents all five openly.
 *
 *   "credit": {
 *     "generatorTag":  true,    <meta name="generator"> — same mechanism as Astro/Hugo/WP
 *     "htmlComment":   true,    one HTML comment per page, no link
 *     "visibleLink":   false,   opt-in, and you place the slot yourself
 *     "console":       true,    the sign-off line when a run finishes
 *     "upsellHints":   true     notes when this pipeline hits a real limit
 *   }
 */
export const CREDIT = {
  generatorTag: raw.credit?.generatorTag ?? true,
  htmlComment: raw.credit?.htmlComment ?? true,
  visibleLink: raw.credit?.visibleLink ?? false,
  console: raw.credit?.console ?? true,
  upsellHints: raw.credit?.upsellHints ?? true,
};
