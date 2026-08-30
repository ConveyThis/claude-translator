# Claude Translator

**Static-site localization: translate a built website into dozens of languages as real
static pages — without re-rendering it, and without breaking Core Web Vitals.**

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](https://nodejs.org)
[![Claude Skill](https://img.shields.io/badge/Claude-Skill-8A63D2.svg)](#using-it-as-a-claude-code-skill)

Point it at a built site, give it a list of locales and your own model API key, and it
produces a complete localized copy of every page — correcting `hreflang`, canonicals,
`dir="rtl"` and per-locale JSON-LD as it goes — then proves the result with eight gates and
a full SEO audit. It holds your terminology, protects your brand names, and writes numbers
the way each locale writes them.

Built and maintained by **[ConveyThis](https://www.conveythis.com/open-source/claude-translator?utm_source=claude-skill&utm_medium=readme-byline&utm_campaign=claude-translator)**.
This is the pipeline that runs **www.conveythis.com itself** — a 238-page Astro site,
live in 55 languages, on the same scripts in this repo.

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

### Does it hold?

[`doctranslator.com/fr`](https://doctranslator.com/fr) is a large Astro site whose French pages
were built by this pipeline. Against the English original, the markup is **byte-identical** —
**2,743 tags in identical sequence**, **all 2,031 `class` attributes matching**, and page weight
up **0.74%**, which is only French being longer than English. Nothing structural moved, so there
is nothing for the browser to lay out differently.

Ten seconds to check:

```bash
curl -s https://doctranslator.com/   | grep -o 'class="[^"]*"' > en.txt
curl -s https://doctranslator.com/fr | grep -o 'class="[^"]*"' > fr.txt
diff en.txt fr.txt && echo "markup identical — only the text changed"
```

PageSpeed Insights performance, measured 25 August 2026:

| | English source | French, from this tool |
| --- | --- | --- |
| Desktop | 100 | **100** |
| Mobile | 98 | **98** |

Accessibility, best practices and SEO were 100 on every run of both pages, in both strategies.

**These are medians, deliberately.** Lighthouse scores move: five consecutive runs of the same
English mobile page returned 98, 98, 88, 98, 98, with LCP swinging between 1.8s and 3.2s. That
is network and CDN variance, not page quality. Measure both languages yourself and compare them
against each other rather than against a number in a README.

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
> never transmitted anywhere else. There is no telemetry — see [PRIVACY.md](PRIVACY.md),
> which shows how to verify that against the source.

---

## Quickstart

```bash
# 1. Install into your project
cd <your-project>
npx claude-translator init
npm install                       # parse5, the only dependency

# 2. Configure — baseUrl, locales, provider
$EDITOR i18n.config.json

# 3. Provide your key (skip entirely for a local model)
echo "ANTHROPIC_API_KEY=your-key-here" >> .env    # .gitignore this

# 4. Run
npm run build                                        # your normal build
node scripts/i18n/extract.mjs                        # find translatable units
node scripts/i18n/translate.mjs --lang es,fr,de      # translate (uses your key)
node scripts/i18n/build-locales.mjs --lang all       # write localized pages
node scripts/i18n/verify.mjs --lang all              # eight gates
node scripts/i18n/audit-seo.mjs                      # full SEO audit
node scripts/i18n/tqa.mjs --lang es                  # MQM quality score (optional)
```

Deploy the resulting build directory exactly as you deploy it today.

`init` copies the pipeline into `scripts/i18n/`, writes a config, declares `parse5`, and adds
the derived `i18n/` paths to `.gitignore`. It **never overwrites anything without `--force`**
and prints every file it touched. `--dir <path>` puts the scripts somewhere else.

<details>
<summary>Installing without npx</summary>

```bash
git clone https://github.com/ConveyThis/claude-translator.git
cp -r claude-translator/scripts  <your-project>/scripts/i18n
cp claude-translator/i18n.config.example.json <your-project>/i18n.config.json
cd <your-project> && npm install --save-dev parse5
```

Or run the scaffolder straight from the clone:
`node claude-translator/bin/claude-translator.mjs init`

</details>

The scripts are copied into your project rather than run from `node_modules` on purpose: they
resolve `parse5` and every relative path from the project they live in, they are short enough to
read, and this is AGPL software whose point is that you can change them.

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
| `glossary` | Term base — an array, or a path to a JSON file. See [Terminology](#terminology-and-brand-names) |
| `localeFormat` | Number, percent and currency **formatting**. See [Numbers and money](#numbers-and-money) |
| `provider` | `anthropic` (default), `gemini`, `openai`, or a path to your own adapter |
| `model` | Any model id for that provider — defaults to the provider's own |
| `apiBaseUrl` | Model API host. Set this for local models, Azure or a gateway. **Not** `baseUrl`, which is your site |
| `apiKeyEnv` | Read the key from a different environment variable |
| `pricing` | `{"in": …, "out": …}` USD per million tokens, for the cost estimate |
| `credit` | Attribution switches — see [Attribution](#attribution) |

`rtlLocales` defaults to `ar, fa, he, ur, ps, sd, ug, yi` and can be overridden.

---

## What you get

**Read this section as "corrected", not "created".** With one exception, this tool does not
add tags to your pages — it rewrites the values on tags your template already emits. That is
deliberate: inserting markup would break the byte-identical guarantee that
[Does it hold?](#does-it-hold) rests on. It also means **your template has to emit the tags
in the first place**, and the two lists below are the difference between what we fix and
what you must supply.

### Rewritten for you, on every page, in every locale

- `<html lang>`, and `dir` flipped to `rtl` where the script requires it — the `lang` and
  `dir` **attributes must already be present** on `<html>`; the value is replaced, never added
- The canonical `href` → this locale's page, `https`, no trailing slash
- The `x-default` and source-language `hreflang` hrefs → pointed at the **original** page,
  not at self. These two are the ones people get wrong; they are also **the only two
  `hreflang` links this tool touches**
- `og:url` / `og:locale` `content` values
- JSON-LD `@id`, `url` and `inLanguage`, per locale — with `Organization` left alone,
  because a company is one entity in every language, and anything unparseable returned
  byte-for-byte
- Internal links, locale-prefixed — assets and anchors left alone
- Your language picker's current-language label and `aria-current`, if it ships the
  `data-i18n-current-lang` / `data-i18n-lang` markers

The only thing ever *inserted* is the ~150-byte attribution described under
[Attribution](#attribution), and you can turn it off.

### Your template must supply these — we audit them, we do not generate them

- **The full `hreflang` mesh.** One `<link rel="alternate">` per locale, plus `x-default`
  and the source language. We rewrite two of those hrefs and check all of them; we emit
  none of them. A site with no alternates gets no alternates.
- **`sitemap.xml`, and any per-locale sitemaps it indexes.** `audit-seo.mjs` validates that
  every sitemap lists the right URLs, that they are `https`, and that each resolves to a
  built page — but nothing in this repo writes a sitemap file.
- **`robots.txt`.** Never read, never written.
- **`og:image`, `twitter:card`, `twitter:site`.** Left untouched. The *text* fields
  (`og:title`, `og:description`, `twitter:title`, image `alt`) are translated.

**Nothing here fails silently.** Every rewrite rule reports when it matched nothing, so a
template change turns into a printed miss rather than a quiet no-op, and `audit-seo.mjs`
checks the whole mesh on *every* page rather than a sample. If your template is missing the
alternates, you will hear about it on the first run — see
[`references/adapting-generators.md`](skills/translate-site/references/adapting-generators.md).

## Terminology and brand names

Two different problems, one file.

**Consistency.** Identical strings are already consistent for free: units are keyed by the
hash of the source text, so a header translated once is reused on every page and across
runs. What that cannot do is hold a *term inside varying sentences* — "Dashboard" in two
different paragraphs is two different units, in two different batches, in two stateless
requests. A glossary fixes that.

**Sense.** `Apple` the company must survive; `apple` the fruit must be translated. A flat
list of names cannot express the difference.

```json
// glossary.json
[
  { "source": "Acme",      "rule": "keep", "matchCase": true },
  { "source": "Dashboard", "rule": "translate",
    "targets": { "es": "Panel de control", "pt-br": "Painel" } }
]
```

| Field | Meaning |
| --- | --- |
| `rule: "keep"` | Leave it in the source language. Defaults to **case-sensitive** |
| `rule: "translate"` | Pin the wording per locale via `targets` |
| `matchCase` | Override the default. `true` means `Apple` is protected and `apple` is not |
| `note` | Free text, passed to the translator and to the quality judge as context |

Matching is **whole-word**, always — `Apple` never matches inside `Applesauce` or
`Appleton`. Only the terms that actually occur in a batch are sent to the model, so a
500-term glossary does not inflate the prompt of every request.

Your existing `doNotTranslate.brands` is folded in automatically as case-sensitive `keep`
rules, so upgrading gains you word-boundary matching and, for the first time, **gate 7**,
which checks the terms actually survived. Before 2.0 nothing verified that: a brand could
be translated away and every gate still passed.

Editing a glossary target re-translates **only** the units containing that term. A
fingerprint sidecar next to the memory records what it was built against.

## Register: buttons are not paragraphs

The prompt has always ended with *"Headings stay headings; button labels stay short."* Until
2.0 the model had no way to obey it — it received the string and nothing else, so a button
label and a body paragraph were indistinguishable.

The extractor always knew the answer and discarded it. Now each unit carries a short label
where the answer changes the translation:

| The string came from | It is told |
| --- | --- |
| `<button>`, or an `<a>` standing on its own | a control — keep it near the source length, no final period |
| `<h1>`–`<h6>` | a headline — do not expand it into a sentence |
| `<title>` | the tab and search-result title |
| `<label>`, `<th>`, `<option>` | short, nominal furniture |
| `alt`, `placeholder`, `aria-label` | described for a screen reader, or shown inside an empty field |
| `<meta name="description">` | search-result copy, roughly 155 characters |

Ordinary prose carries **no label at all**, so a site of nothing but paragraphs sends a
payload byte-identical to 1.x and pays nothing for the feature. The prompt describes only the
roles that actually appear in each batch.

Two things it deliberately does not do. It does **not** demand the imperative for buttons —
German UI prefers a verbal noun, French the infinitive, and ordering a literal command in
every language is the defect this exists to prevent; it tells the model to use whatever
construction that language puts on buttons. And when the same string appears as both a button
and a paragraph it **clears** the hint rather than guessing, because one hash means one
translation and a confident wrong answer is worse than none.

There is no length *enforcement* — no character budget, no retry on overflow. Failed units
ship in the source language, so a hard gate here would replace a slightly-long German button
with an English one. That is a worse page.

## Numbers and money

`1,234.56` is `1.234,56` in German and `1 234,56` in French. `$5` is `5,00 $US` in French.
Getting this wrong is one of the most visible marks of a machine translation, and models
are unreliable at it — so the model is told to leave numbers **alone** (rule 4), and the
formatting is applied deterministically afterwards with `Intl`.

```json
"localeFormat": { "numbers": true, "percent": true, "currency": "format", "units": "off" }
```

**Currency is formatted, never converted, and there is no option to convert it.** A price
is a commercial commitment. Converting one at a rate baked into a build — a rate that is
stale the day after it is written — is how a translation tool starts publishing wrong
offers. What you get instead is `i18n/locale-format.json`, listing every monetary amount
found, so a human can decide per market.

**Gate 8 backs this up**: if the *value* of a number changes between source and
translation, the build fails. A model that quietly ships `$39` where the source said `$49`
passes every other check — the markup is identical, the placeholders match, the length is
plausible and the Spanish is fluent.

Things it deliberately leaves alone, because a "fix" here is a corruption: version numbers
(`Node 20.5.1`), times (`10:30`), IP addresses, ISO dates, phone numbers, fractions, and
any ungrouped number. Only unambiguous quantities are touched.

Unit conversion (in→cm, °F→°C) is **not implemented**. The `units` key is accepted and
ignored so a config written today keeps parsing when it lands.

> One thing that looks like a bug and is not: Spanish does not group four-digit numbers,
> so `1,234.50` correctly becomes `1234,50` in `es` and `1.234,50` in `de`. That is CLDR,
> and there is a test pinning it.

## Trusting the output

Machine translation at scale fails in ways that look like success. Two commands exist to
catch that.

**`verify.mjs` — eight gates**

| # | Gate | Catches |
| --- | --- | --- |
| 1 | URL parity | a missing page — a dead URL in a language you now advertise |
| 2 | Structure | tag sequence differs from the source page → substitution damaged markup |
| 3 | Placeholder leak | a raw `<0>` survived into shipped HTML |
| 4 | Locale identity | wrong `lang`, canonical, `hreflang` or JSON-LD |
| 5 | Coverage | share of extracted segments present in the memory |
| 6 | **Never offered** | visible text the extractor never picked up |
| 7 | Glossary | a protected brand that got translated, or a pinned term rendered some other way |
| 8 | Numeric integrity | a number whose **value** changed — `$49` shipped as `$39` |

Gate 6 exists because **coverage is not completeness**. Coverage measures
translated-of-*extracted*, so it is structurally blind to extraction bugs. A single bug has
been observed reporting 100% coverage while every icon+label pair on a site remained
untranslated. Gate 6 compares built output against the source instead.

**`audit-seo.mjs`** then checks canonicals, the full hreflang mesh, `og` tags, JSON-LD and
sitemaps across *every* page — not a sample.

**`tqa.mjs` — a quality score you can reproduce**

The gates prove the plumbing. They say nothing about whether the Spanish is any *good*.
That is what `tqa.mjs` is for.

```bash
node scripts/i18n/tqa.mjs --lang es --dry      # sample size and cost, no API call
node scripts/i18n/tqa.mjs --lang es,fr,de      # writes i18n/tqa/{lang}.json + scorecard.md
node scripts/i18n/tqa.mjs --lang es --repeat   # judge the same sample twice, report the gap
```

It scores a **stratified sample** — weighted by how often each string appears on the site,
so the header everyone reads counts for more than a one-off footnote — using the **MQM**
error typology the localization industry already uses:

```
score = 100 − (weighted error points ÷ words) × 100      minor 1 · major 5 · critical 10
```

Four things make the number honest rather than decorative:

- **The judge defaults to a different provider than the translator.** Models prefer their
  own output. If no second key is configured it says so, loudly, in the run and in the
  report.
- **The sample is seeded.** `--seed` reproduces a score exactly. A quality figure nobody
  can re-derive is a marketing figure.
- **`--repeat` reports the judge's own variance** by scoring the same sample twice. A score
  quoted without its noise invites people to over-read a decimal place.
- **A unit the judge cannot assess is excluded, not counted as clean.** During development
  a misconfigured endpoint failed every single unit and the run printed `100.00 / 100` from
  an empty sample. It now refuses to report a score at all in that case.

Read it as a comparison — between locales, between models, between runs — and not as a
grade. It is one model's opinion of another's work, it is not a human review, and the
report says so on its face.

**`review.mjs`** flags likely translation defects: dropped placeholders, wholesale
source-language returns, wrong target language, truncated output. Read
[`skills/translate-site/references/quality-review.md`](skills/translate-site/references/quality-review.md) before acting on its output —
purging is destructive and its heuristics have known blind spots.

---

## Models and providers

The translation step is the only part that talks to a model, and it talks through a small
adapter. Three ship with the project, and anything else is one file.

| `provider` | Default model | Key | Last verified against the live API |
| --- | --- | --- | --- |
| `anthropic` *(default)* | `claude-haiku-4-5` | `ANTHROPIC_API_KEY` | 2026-08-25 |
| `gemini` | `gemini-2.5-flash-lite` | `GEMINI_API_KEY` | 2026-08-25 |
| `openai` | `gpt-5.6-luna` | `OPENAI_API_KEY` | 2026-08-25 |
| `./my-provider.mjs` | — | yours | — |

Omit `provider` and it is inferred from the model id, so configs written before 1.2 keep
working unchanged.

**What "verified" means in that last column.** On 2026-08-25 each of the three adapters
translated the same 98-unit, 1,381-word English site into Russian at its default model, as a
real billed API call, with the translation memory deleted between runs so no provider could
reuse another's work. Every run cleared all gates in `verify.mjs` and produced a clean
`audit-seo.mjs` — 0 findings — and no run had a single failed unit. Measured cost: $0.025
(Claude), $0.002 (Gemini), and 3,453/2,855 tokens on OpenAI, which the adapter deliberately
does not price because it points at dozens of endpoints, some of them free and local.

The three memories agreed on only 28–36% of units pairwise, and the ones all three agreed on
were short labels like "Три плана". That divergence is the evidence the runs were independent.

This column is a freshness marker, not a guarantee. Model ids get retired; if a default stops
working, that is what this date is for. The contract tests in `scripts/providers/` still run
on every commit with no network and no key — they catch a malformed request, not a rejected
one.

**Reasoning models and `temperature`.** The `openai` default is a reasoning model, and those
reject sampling parameters — GPT-5.x answers a `temperature: 0.2` with
`400 Unsupported value: 'temperature' … Only the default (1) value is supported`. The adapter
handles this twice over: it omits `temperature` and sends `reasoning_effort: 'none'` for model
ids it recognises as reasoning models, and if a server rejects a parameter anyway, the run drops
that one parameter and retries instead of failing. A pinned `gpt-4o-mini`, and every local model,
still get `temperature` exactly as before.

`reasoning_effort` is `'none'` because bulk segment translation is a low-reasoning task — the
same reason the Anthropic adapter pins its thinking tiers to `effort: 'low'`. Paying for a
reasoning pass on every batch of forty segments is the one cost here worth engineering away.

**Pricing.** `gpt-5.6-luna` is $0.20 in / $1.20 out per million tokens. The adapter reports no
cost, deliberately — `pricing()` cannot see `baseUrl`, so it cannot tell OpenAI itself from
OpenRouter or a local server offering the same model id. Set `pricing` in `i18n.config.json` to
get a figure in the run summary.

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
[`skills/translate-site/references/throughput-and-cost.md`](skills/translate-site/references/throughput-and-cost.md). Changing it is
one line. Writing your own adapter is about thirty — see
[`skills/translate-site/references/providers.md`](skills/translate-site/references/providers.md).

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

### The visible credit is opt-in

If you *want* to show a credit, set `visibleLink: true` and place the slot yourself, wherever
you want it:

```html
<span data-conveythis-credit></span>
```

Nothing is injected anywhere else, and if the flag is on and no slot exists the build tells
you rather than guessing. Nothing is asked of you for it and nothing is given in return — it
exists because some people want to credit the tools they use, and for no other reason.

The link is `rel="nofollow"`. Not because it is paid — it is not — but because it is a link a
build script would otherwise add across every page of a site, and sitewide links that appear
because of tooling rather than editorial choice are the shape Google's link-scheme guidance is
aimed at. It is worth referral traffic, not backlinks, and anyone telling you otherwise is
selling you a penalty.

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

## Using it as a Claude Code plugin

This repo is also a self-contained [Claude Code](https://claude.com/claude-code) plugin, named
`conveythis-translator`. Once it is approved for the community directory:

```bash
/plugin marketplace add anthropics/claude-plugins-community
/plugin install conveythis-translator@claude-community
```

Plugin skills are namespaced, so it is invoked as `/conveythis-translator:translate-site` — or
just ask Claude to "localize this site" and it will pick the skill up on its own. It follows
`skills/translate-site/SKILL.md`, including the failure modes in `references/` and the routing
rules for when this is the wrong tool entirely.

To run it before it is listed, clone the repo anywhere and point Claude Code at it:

```bash
git clone https://github.com/ConveyThis/claude-translator.git
claude --plugin-dir ./claude-translator
```

To keep it permanently available without installing, symlink the **skill directory itself** into
your personal skills folder — it is self-contained, references included:

```bash
ln -s "$PWD/claude-translator/skills/translate-site" ~/.claude/skills/translate-site
```

---

## Documentation

| Document | Read it when |
| --- | --- |
| [`skills/translate-site/references/failure-modes.md`](skills/translate-site/references/failure-modes.md) | **Before modifying any script.** Every known bug: symptom → cause → fix |
| [`skills/translate-site/references/quality-review.md`](skills/translate-site/references/quality-review.md) | Before purging anything the reviewer flags, or reading a TQA score |
| [`skills/translate-site/references/throughput-and-cost.md`](skills/translate-site/references/throughput-and-cost.md) | Budgeting a run, or making it faster |
| [`skills/translate-site/references/adapting-generators.md`](skills/translate-site/references/adapting-generators.md) | Using anything other than Astro |
| [`skills/translate-site/references/providers.md`](skills/translate-site/references/providers.md) | Changing model, running locally, or writing an adapter |
| [`PRIVACY.md`](PRIVACY.md) | You want to know exactly what leaves your machine, and how to check |
| [`LICENSING.md`](LICENSING.md) | You are wrapping a modified copy in a hosted service |

## Supported generators

Anything that emits static HTML: **Astro**, **Next.js** (`output: 'export'`), **Hugo**,
**Eleventy**, **Jekyll**, **Gatsby**, or hand-written HTML. See
[`skills/translate-site/references/adapting-generators.md`](skills/translate-site/references/adapting-generators.md) for per-generator
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
