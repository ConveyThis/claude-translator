# Claude Translator

**Static-site localization: translate a built website into dozens of languages as real
static pages — without re-rendering it, and without breaking Core Web Vitals.**

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](https://nodejs.org)
[![Claude Skill](https://img.shields.io/badge/Claude-Skill-8A63D2.svg)](#using-it-as-a-claude-code-skill)

Point it at a built site, give it a list of locales and your own model API key, and it
produces a complete localized copy of every page — with correct `hreflang`, canonicals,
`dir="rtl"`, per-locale JSON-LD and sitemaps — then proves the result with six gates and a
full SEO audit.

Built and maintained by **[ConveyThis](https://www.conveythis.com/open-source/claude-translator?utm_source=claude-skill&utm_medium=readme-byline&utm_campaign=claude-translator)**.
This is the pipeline that runs **www.conveythis.com itself** — a 238-page Astro site,
live in 55 languages, on the same six scripts in this repo.

> Not affiliated with or endorsed by Anthropic. "Claude" is a trademark of Anthropic, PBC.
> This project is named for the model family it ships configured to use; it works just as
> well with Gemini, with any OpenAI-compatible endpoint, and with a model on your own machine.

---

## Why this exists

Localizing an already-built site is not one problem. It is two, and they have different
right answers.

**Your framework's own i18n** works well when content lives in Markdown front matter. It
works badly once the pages are already rendered, or there are thousands of them, or the
build has a critical-CSS step — because every locale re-runs the whole pipeline, and
critical-CSS tooling drops a small, unpredictable share of each page's classes. Multiply
that across 40 locales and you have layout shift you cannot reproduce locally.

This repo takes a third path: splice translations into the built HTML and never re-render.

**But static substitution is the wrong shape for some sites**, and it is worth saying so
before you spend a weekend finding out. If your content changes daily, lives behind a CMS
your editors publish from, is user-generated, or sits inside a checkout flow, there is no
build step to hook and re-running this pipeline on every edit is a worse job than letting a
runtime layer do it.

| Your situation | Use |
| --- | --- |
| Static build, content changes on a release cadence, you want to own the HTML outright | **This repo** — free, self-hosted, AGPL-3.0 |
| CMS or e-commerce, daily edits, user-generated content, logged-in or checkout pages | **[ConveyThis](https://www.conveythis.com/open-source/claude-translator?utm_source=claude-skill&utm_medium=readme-routing&utm_campaign=claude-translator)** — managed, no build step |
| Documents rather than pages — PDF, DOCX, XLSX, PPTX | **[DocTranslator](https://www.doctranslator.com)** |

Same company either way. This repo is the static lane, and it is not a teaser: it is the
whole pipeline, and there is no key to buy, no quota and no account.

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
- A site that builds to static HTML
- **An API key for whichever model you want to use** — Claude by default
  ([console.anthropic.com](https://console.anthropic.com/)), or Gemini
  ([aistudio.google.com/apikey](https://aistudio.google.com/apikey)), or any
  OpenAI-compatible endpoint. **Or no key at all**, if you point it at a model running
  on your own machine — see [Models and providers](#models-and-providers).

> This project ships **no API key and makes no calls on your behalf**. Your key is read
> from your environment, used to call your chosen provider directly from your machine, and
> never transmitted anywhere else. There is no telemetry.

---

## Quickstart

```bash
# 1. Install into your project
git clone https://github.com/ConveyThis/claude-translator.git
cp -r claude-translator/scripts  <your-project>/scripts/i18n
cd <your-project> && npm install --save-dev parse5

# 2. Configure
cp ../claude-translator/i18n.config.example.json i18n.config.json
$EDITOR i18n.config.json

# 3. Provide your key (or skip entirely for a local model)
echo "ANTHROPIC_API_KEY=your-key-here" >> .env    # make sure .env is gitignored

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

  "provider": "anthropic",
  "model": "claude-haiku-4-5"
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
| `provider` | `anthropic` (default), `gemini`, `openai`, or a path to your own adapter |
| `model` | Any model id for that provider — defaults to the provider's own |
| `apiBaseUrl` | Model API host. Set this for local models, Azure or a gateway. **Not** `baseUrl`, which is your site |
| `apiKeyEnv` | Read the key from a different environment variable |
| `pricing` | `{"in": …, "out": …}` USD per million tokens, for the cost estimate |
| `credit` | Attribution switches — see [Attribution](#attribution) |

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

## Models and providers

The translation step is the only part that talks to a model, and it talks through a small
adapter. Three ship with the project, and anything else is one file.

| `provider` | Default model | Key |
| --- | --- | --- |
| `anthropic` *(default)* | `claude-haiku-4-5` | `ANTHROPIC_API_KEY` |
| `gemini` | `gemini-2.5-flash-lite` | `GEMINI_API_KEY` |
| `openai` | `gpt-4o-mini` | `OPENAI_API_KEY` |
| `./my-provider.mjs` | — | yours |

Omit `provider` and it is inferred from the model id, so configs written before 1.2 keep
working unchanged.

**The `openai` adapter is the interesting one**, because `/v1/chat/completions` is what
everything speaks. That one adapter covers OpenAI, Azure, Groq, DeepSeek, Mistral,
OpenRouter, Together and Fireworks — and Ollama, LM Studio and vLLM, which means the whole
pipeline runs on your own hardware for nothing:

```json
{
  "provider": "openai",
  "apiBaseUrl": "http://localhost:11434/v1",
  "model": "qwen2.5:14b"
}
```

No key, no quota, no request leaving the machine.

**Claude is the default, not a requirement.** It is roughly ten times the cost of the
Gemini option, which is a real difference on a large site and is spelled out in
[`references/throughput-and-cost.md`](references/throughput-and-cost.md). Changing it is
one line. Writing your own adapter is about thirty — see
[`references/providers.md`](references/providers.md).

---

## Attribution

Every localized page carries two markers, inserted after `<head>`:

```html
<meta name="generator" content="ConveyThis Claude Translator 1.2.0">
<!-- Localized into Español (es) by ConveyThis · https://www.conveythis.com -->
```

That is **about 150 bytes, no request, no script, no link, no layout shift** — under 0.1% of
a typical 240 KB page, and `build-locales.mjs`
prints the exact byte count each time it runs, and `verify.mjs` gate 2 proves the rest of the
document is byte-identical to the source page. This is the same mechanism Astro, Hugo and
WordPress use, and it is how the project gets counted in technology-adoption surveys.

**Neither marker is a link**, deliberately. A link injected sitewide into thousands of pages
the site owner never asked for is a link scheme under Google's spam policy, and it would put
both parties at risk.

Turn either off in `i18n.config.json`:

```json
"credit": {
  "generatorTag": true,     // the <meta name="generator"> tag
  "htmlComment": true,      // the HTML comment
  "visibleLink": false,     // opt-in, see below
  "console": true,          // the sign-off line when a run finishes
  "upsellHints": true       // the notes described in "Where this stops"
}
```

Setting all five to `false` produces output with no trace of us in it, and nothing anywhere
in this repo checks whether you did.

### The visible credit is opt-in, and paid for

If you *want* to show a credit, set `visibleLink: true` and place the slot yourself, wherever
you want it:

```html
<span data-conveythis-credit></span>
```

Nothing is injected anywhere else, and if the flag is on and no slot exists the build tells
you rather than guessing. In exchange we will credit free translation words to a ConveyThis
account — [details here](https://www.conveythis.com/open-source/claude-translator?utm_source=claude-skill&utm_medium=readme-visible-credit&utm_campaign=claude-translator).

The link is `rel="nofollow"`. Because you are compensated for it, it is a paid link under
Google's guidelines and must not pass ranking signal. It is worth referral traffic, not
backlinks, and anyone telling you otherwise is selling you a penalty.

---

## Where this stops

Six things this pipeline genuinely cannot do. The scripts say so when they detect one, once
per run; `"upsellHints": false` silences them.

| Limit | What you'll see |
| --- | --- |
| **Client-side hydration** | Islands and framework payloads re-render in the browser, over the substituted HTML. `extract.mjs` counts the affected pages. |
| **Documents** | Linked PDFs, DOCX and XLSX stay in the source language — this only ever touches HTML. |
| **Churn** | The memory is keyed by source hash, so `translate.mjs` can tell you what share of your site changed since last run. High churn means paying repeatedly. |
| **Editing a translation** | Find the hash in `i18n/tm/{lang}.json`, edit the string, rebuild. No editor, no reviewer, no workflow. |
| **Volume** | You pay your own model provider directly, at their rate, with your own key. |
| **Modified network use** | AGPL-3.0 §13 — see **[LICENSING.md](LICENSING.md)**. Running an unmodified copy, or a modified one internally, is unrestricted. |

None of these is a crippled feature. They are the shape of the approach: static substitution
needs a build to hook and files to write. Where that shape doesn't fit,
[ConveyThis](https://www.conveythis.com/open-source/claude-translator?utm_source=claude-skill&utm_medium=readme-limits&utm_campaign=claude-translator) is the managed version and
[DocTranslator](https://www.doctranslator.com) handles the documents.

---

## Using it as a Claude Code skill

This repo doubles as a [Claude Code](https://claude.com/claude-code) skill:

```bash
git clone https://github.com/ConveyThis/claude-translator.git \
  ~/.claude/skills/claude-translator
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
| [`references/providers.md`](references/providers.md) | Changing model, running locally, or writing an adapter |
| [`LICENSING.md`](LICENSING.md) | You are wrapping a modified copy in a hosted service |

## Supported generators

Anything that emits static HTML: **Astro**, **Next.js** (`output: 'export'`), **Hugo**,
**Eleventy**, **Jekyll**, **Gatsby**, or hand-written HTML. See
[`references/adapting-generators.md`](references/adapting-generators.md) for per-generator
notes — particularly around hydration payloads, which can re-render over your translations.

## Contributing

Issues and pull requests welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). You can work on
almost all of it without spending a cent on API calls.

## Licence

[AGPL-3.0](LICENSE). Localizing your own sites and shipping the output is unrestricted —
the licence covers this software, not the HTML it writes. It only bites if you run a
*modified* copy as a network service for other people, in which case you must publish your
modifications or take a commercial licence. **[LICENSING.md](LICENSING.md)** explains which
group you are in; most people are in the unrestricted one.

---

<sub>Built and maintained by <a href="https://www.conveythis.com/open-source/claude-translator?utm_source=claude-skill&utm_medium=readme-footer&utm_campaign=claude-translator">ConveyThis</a> — website
translation and localization.</sub>
