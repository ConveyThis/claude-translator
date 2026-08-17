# static-site-localization

**Translate a static website into dozens of languages as real static pages — without
re-rendering it, and without breaking Core Web Vitals.**

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](https://nodejs.org)
[![Claude Skill](https://img.shields.io/badge/Claude-Skill-8A63D2.svg)](#using-it-as-a-claude-code-skill)

Point it at a built site, give it a list of locales and your own Gemini API key, and it
produces a complete localized copy of every page — with correct `hreflang`, canonicals,
`dir="rtl"`, per-locale JSON-LD and sitemaps — then proves the result with six gates and a
full SEO audit.

Built and maintained by **[ConveyThis](https://conveythis.com)**.

---

## Why this exists

The obvious approach is your framework's own i18n. That works well when your content lives
in Markdown front matter. It works badly when the pages are already rendered, when there are
thousands of them, or when your build has a critical-CSS step — because every locale
re-runs the whole pipeline, and critical-CSS tooling drops a small, unpredictable share of
each page's classes. Multiply that across 40 locales and you have layout shift you cannot
reproduce locally.

The other common approach is a translation proxy that rewrites pages at request time. That
costs you TTFB on every request, and you do not own the output — the proxy controls your
canonical tags, your `hreflang`, and whether the page is cached at all.

This takes a third path.

### The two design decisions

**1. Substitute into built HTML by byte offset. Never re-render.**

Each locale page is the source page with byte ranges spliced right-to-left. The document is
never re-serialised from a DOM, so inlined critical CSS, the LCP element, asset hashes and
the `width`/`height` attributes that hold CLS all carry over untouched. That is *why* locale
pages match the source language on Core Web Vitals rather than merely resembling it.

**2. Translate blocks, not text nodes.**

Around a fifth of a typical site's text nodes are split by inline markup:

```html
<p>With <strong>Acme</strong>, you'll get a streamlined flow.</p>
```

Translating `"With"` and `", you'll get a streamlined flow."` separately produces broken
grammar in any language that reorders or inflects. So the unit of translation is the whole
block, with inline tags replaced by numbered placeholders the model carries through:

```
With <0>Acme</0>, you'll get a streamlined flow.
```

The builder restores the original tags by index.

---

## Requirements

- **Node.js ≥ 20**
- **Your own Google Gemini API key** — get one free at
  [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
- A site that builds to static HTML

> This project ships **no API key and makes no calls on your behalf**. Your key is read
> from your environment, used to call Google's API directly from your machine, and never
> transmitted anywhere else. There is no telemetry.

---

## Quickstart

```bash
# 1. Install into your project
git clone https://github.com/ConveyThis/static-site-localization.git
cp -r static-site-localization/scripts  <your-project>/scripts/i18n
cd <your-project> && npm install --save-dev parse5

# 2. Configure
cp static-site-localization/i18n.config.example.json i18n.config.json
$EDITOR i18n.config.json

# 3. Provide your key
echo "GEMINI_API_KEY=your-key-here" >> .env    # make sure .env is gitignored

# 4. Run
npm run build                                        # your normal build
node scripts/i18n/extract.mjs                        # find translatable units
node scripts/i18n/translate.mjs --lang es,fr,de      # translate (uses your key)
node scripts/i18n/build-locales.mjs --lang all       # write localized pages
node scripts/i18n/verify.mjs --lang all              # six gates
node scripts/i18n/audit-seo.mjs                      # full SEO audit
```

Deploy the resulting build directory exactly as you deploy it today.

---

## Configuration

`i18n.config.json` is the only file that knows anything about your site.

```json
{
  "buildDir": "dist",
  "baseUrl": "https://example.com",
  "sourceLanguage": "English",
  "siteName": "Acme",
  "siteDescription": "an online project-management tool",

  "locales": [
    { "hreflang": "es",    "pathCode": "es",    "nativeLabel": "Español" },
    { "hreflang": "pt-BR", "pathCode": "pt-br", "nativeLabel": "Português (Brasil)" },
    { "hreflang": "ar",    "pathCode": "ar",    "nativeLabel": "العربية" }
  ],

  "pages": { "source": "build", "exclude": ["404", "admin"] },

  "doNotTranslate": {
    "brands":  ["Acme", "Acme Cloud Inc"],
    "formats": ["PDF", "DOCX", "XLSX"]
  },

  "model": "gemini-2.5-flash-lite"
}
```

| Key | Meaning |
| --- | --- |
| `buildDir` | Where your generator writes HTML (`dist`, `out`, `public`, `_site`…) |
| `baseUrl` | Canonical origin, no trailing slash |
| `sourceLanguage` | The language your built site is written in |
| `siteName` / `siteDescription` | Given to the translator so it picks the right register |
| `locales[]` | `hreflang` (ISO 639-1, region UPPERCASE), `pathCode` (URL segment), `nativeLabel` |
| `pages.source` | `"build"` to derive from output, or a path to a slug list |
| `pages.exclude` | First path segments never to localize — 404 pages, CMS admin shells |
| `doNotTranslate` | Brand names and formats that must survive unchanged |
| `model` | Any Gemini model id |

`rtlLocales` defaults to `ar, fa, he, ur, ps, sd, ug, yi` and can be overridden.

---

## What you get

For every page, in every locale:

- `<html lang>` and `dir="rtl"` where the script requires it
- A self-referencing canonical — `https`, no trailing slash
- A complete `hreflang` set: every locale, plus `x-default` and the source language
  pointing at the **original** page, not at self
- `og:url` / `og:locale`
- JSON-LD with per-locale `@id`, `url` and `inLanguage` — and `Organization` left alone,
  because a company is one entity in every language
- Locale-prefixed internal links
- Per-locale sitemaps

## Trusting the output

Machine translation at scale fails in ways that look like success. Two commands exist to
catch that.

**`verify.mjs` — six gates**

| # | Gate | Catches |
| --- | --- | --- |
| 1 | URL parity | a missing page — a dead URL in a language you now advertise |
| 2 | Structure | tag sequence differs from the source page → substitution damaged markup |
| 3 | Placeholder leak | a raw `<0>` survived into shipped HTML |
| 4 | Locale identity | wrong `lang`, canonical, `hreflang` or JSON-LD |
| 5 | Coverage | share of extracted segments present in the memory |
| 6 | **Never offered** | visible text the extractor never picked up |

Gate 6 exists because **coverage is not completeness**. Coverage measures
translated-of-*extracted*, so it is structurally blind to extraction bugs. A single bug has
been observed reporting 100% coverage while every icon+label pair on a site remained
untranslated. Gate 6 compares built output against the source instead.

**`audit-seo.mjs`** then checks canonicals, the full hreflang mesh, `og` tags, JSON-LD and
sitemaps across *every* page — not a sample.

**`review.mjs`** flags likely translation defects: dropped placeholders, wholesale
source-language returns, wrong target language, truncated output. Read
[`references/quality-review.md`](references/quality-review.md) before acting on its output —
purging is destructive and its heuristics have known blind spots.

---

## Using it as a Claude Code skill

This repo doubles as a [Claude Code](https://claude.com/claude-code) skill:

```bash
git clone https://github.com/ConveyThis/static-site-localization.git \
  ~/.claude/skills/static-site-localization
```

Then ask Claude to "localize this site" and it will follow `SKILL.md`, including the
failure modes documented in `references/`.

---

## Documentation

| Document | Read it when |
| --- | --- |
| [`references/failure-modes.md`](references/failure-modes.md) | **Before modifying any script.** Every known bug: symptom → cause → fix |
| [`references/quality-review.md`](references/quality-review.md) | Before purging anything the reviewer flags |
| [`references/throughput-and-cost.md`](references/throughput-and-cost.md) | Budgeting a run, or making it faster |
| [`references/adapting-generators.md`](references/adapting-generators.md) | Using anything other than Astro |

## Supported generators

Anything that emits static HTML: **Astro**, **Next.js** (`output: 'export'`), **Hugo**,
**Eleventy**, **Jekyll**, **Gatsby**, or hand-written HTML. See
[`references/adapting-generators.md`](references/adapting-generators.md) for per-generator
notes — particularly around hydration payloads, which can re-render over your translations.

## Contributing

Issues and pull requests welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). You can work on
almost all of it without spending a cent on API calls.

## Licence

[AGPL-3.0](LICENSE). If you run a modified version as a network service, you must publish
your modifications.

---

<sub>Built and maintained by <a href="https://conveythis.com">ConveyThis</a> — website
translation and localization.</sub>
