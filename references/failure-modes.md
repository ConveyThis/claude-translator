# Failure modes

Every one of these was hit in production on a 55-locale rollout. They are listed because
each **looked like working code**, and several produced wrong output that reported success.

Read this before modifying any script.

---

## Extraction

### A skipped element inside a block silently drops the whole block

**Symptom:** coverage 100%, gates green, yet "Translate a Document", "Sign Up Free" and
every `✓ feature` bullet render in the source language.

**Cause:** the tokenizer treated `<svg>` as "skip", and skipping aborted the *entire*
containing block. Every icon+label pair on the site — buttons, feature bullets, badges —
was never offered for translation. **Thousands of segments, invisible.**

**Fix:** an opaque element becomes **one void placeholder** carrying the element verbatim.
Never abandon a unit because of a child.

**Detection:** gate 6 in `verify.mjs`. Coverage cannot see this class of bug at all.

### The extractor scans its own output

**Symptom:** unit and segment counts roughly double; the memory starts filling with
target-language strings keyed as source.

**Cause:** locale directories live inside the build directory, so a naive recursive scan
reads `dist/es/**` as if it were source.

**Fix:** exclude every configured `pathCode` from the scan (`config.mjs` does this).

### JSON-LD bare-value search matches substrings

**Symptom:** `Overlapping segments … Aborting.`

**Cause:** searching for a bare value finds it inside a longer sibling —
`"name":"PDF Translator"` sits within `"name":"AI PDF Translator"` — producing overlapping
byte ranges that would corrupt output.

**Fix:** match the full `"key"\s*:\s*"value"` pair, never the value alone.

### Language-switcher labels drift per locale

**Symptom:** the picker reads differently on every locale — `English (English)` becomes
`Inglés (English)` on Spanish while `Español (Spanish)` stays put.

**Cause:** a language picker shows every language in **its own** language. These are data,
not copy.

**Fix:** treat `Native (EnglishName)` strings and bare native labels as do-not-translate.
Apply the same rule in the verifier, or gate 6 will report them as holes.

---

## Translation API

### Network exceptions bypass status-code retry

**Symptom:** a run finishes "successfully" with several hundred units missing.

**Cause:** `TypeError: fetch failed` (DNS, reset, socket timeout) throws **before** any
response exists, so `if (!res.ok)` never sees it. Cost: **hundreds of units** lost silently in a single run.

**Fix:** wrap the `fetch` itself and retry on the same backoff as 429/5xx.

### A batch that exceeds the output limit returns truncated JSON

**Symptom:** `SyntaxError: Unterminated string in JSON at position …`, 40 units gone.

**Fix:** catch the parse error, split the batch in half, recurse. Only a single oversized
unit can then be unrecoverable.

### The safety filter blocks the whole request

**Symptom:** `promptFeedback.blockReason: PROHIBITED_CONTENT`, no candidates, 40 units gone.

**Cause:** one string the filter dislikes takes the other 39 with it.

**Fix:** same split-and-recurse path.

### Memory written only at the end

**Symptom:** a 40-minute run is interrupted and *everything* is lost.

**Fix:** checkpoint every ~10 batches. This later saved thousands of units when a long run
had to be killed and restarted.

### The model silently returns the source language

Not an API error — a **quality** failure that every structural gate passes. See
`quality-review.md`; word-overlap detection is what catches it.

---

### `output_config.effort` is rejected on Haiku

**Symptom.** Every Anthropic request fails with a 400 naming `effort`, on a model that
otherwise works.

**Cause.** Claude tiers do not take the same parameters. `claude-haiku-4-5` rejects
`output_config.effort` outright; the Opus and Sonnet tiers accept it.

**Fix.** `providers/anthropic.mjs` keeps a capability table and sends the parameter only
where it is accepted. Adding a model means adding it to `ACCEPTS_EFFORT`, not assuming.

### Adaptive thinking is on by default, and translation pays for it

**Symptom.** A run on Opus or Sonnet costs several times the estimate, with output token
counts far above what the translated text can account for.

**Cause.** Those models run adaptive thinking unless told otherwise. Segment translation
has no use for it, but it is billed all the same.

**Fix.** The adapter pins `output_config.effort: 'low'` on the tiers that support it.
Do **not** "fix" this by setting `thinking: {type: 'disabled'}` — on Opus 5 that has its
own failure modes, including writing a tool call into visible text.

### Local models wrap JSON in a code fence

**Symptom.** Works on a hosted provider, fails on Ollama or LM Studio with
`Unexpected token \`` on every batch.

**Cause.** Smaller models emit ` ```json … ``` ` regardless of instructions, and some
prepend a sentence of preamble.

**Fix.** `extractJson()` in `providers/index.mjs` strips fences and falls back to the
outermost bracket pair. Never assume the response body starts with `[`.

### A server rejects `response_format` and the run dies

**Symptom.** An OpenAI-compatible endpoint returns 400 mentioning `response_format` or
`json_schema`, and nothing translates.

**Cause.** The structured-output field is not universal across "OpenAI-compatible"
servers. Many implement `json_object` only; some implement neither.

**Fix.** `unsupportedJsonMode()` distinguishes that rejection from a genuine bad request,
and `translate.mjs` drops one rung — `json_schema` → `json_object` → prompt only — rather
than failing. Placeholder validation still guards the output, so the weaker mode costs
retries and not correctness. A real error (bad key, unknown model) must **not** match this
path, which is why the pattern is narrow.

### Locale pages built from a stale source build

**Symptom.** The locale pages' inlined critical CSS no longer matches the source page's, and
each carries rules for classes the other one uses. Tag sequence and `class` attributes still
match perfectly, so substitution clearly worked — but the two pages disagree about their CSS.

**Cause.** The source site was rebuilt *after* the locale pages were generated, and
critical-CSS extraction is not stable across builds. Observed live on a production site: two
builds three hours apart, identical markup, and the later build's critical CSS gained
`.bg-sky-500`, `.bg-slate-100`, `.object-cover` and `.scale-150` while losing `.aspect-video`.
Neither build's CSS was a correct match for its own markup.

This is the same instability that makes per-locale re-rendering a bad idea, showing up in a
different place — and it is a useful reminder that the tooling is the unreliable part, not the
substitution.

**Fix.** Re-run `build-locales.mjs` after any rebuild that changes markup. It is nearly free:
the translation memory is keyed by source text, so nothing is re-translated and no API call is
made. Cheap enough to put in the same CI step as the build itself.

**How to spot it.** Compare an inlined `<style>` block between a source page and its locale
twin. Substitution never touches `<style>` contents, so if they differ, the locale page was
built from a different snapshot than the one you are looking at.

### A model id sent to the wrong provider

**Symptom.** After upgrading to 1.2, an existing project fails with an unhelpful
"unknown model" from an API it never used before.

**Cause.** 1.2 changed the default provider to Anthropic. A config from 1.0/1.1 pins a
Gemini model id and has no `provider` key.

**Fix.** `inferProvider()` derives the provider from the model id when `provider` is
absent, so those configs keep working. Only a config with neither key gets the default.
The run prints which provider it resolved and whether it was inferred — read that line
before debugging anything else.

## Building locale pages

### Attribute order is not guaranteed

**Symptom:** canonical/hreflang/og rewrites do nothing, build reports success.

**Cause:** a builder emitted `<link href="…" rel="canonical">`; the regex assumed `rel`
first. Every identity rule silently no-opped.

**Fix:** parse attributes into a map rather than matching positionally, **and report any
rule that matched zero occurrences**. That report is what surfaced it.

### Not every schema `url` is the page URL

**Symptom:** `Organization.url` becomes `/es/about` — the company relocated to a subpage.

**Cause:** blanket rewriting of every `url` in JSON-LD.

**Fix:** only page-level types (`WebPage`, `AboutPage`, `FAQPage`, `ContactPage`, …) get
the page URL. `WebSite.url` gets the **locale root**. `Organization` is one entity across
all languages — leave it alone.

### The home link gains a trailing slash

`href="/"` naively prefixed becomes `/es/`, which 301-redirects back to `/es` — a
needless redirect on the logo of every page, contradicting the canonical. Special-case the
empty path.

### One component, two instances

A non-global regex patches only the first. If a component is mounted twice (mobile +
desktop header), every per-locale rewrite needs the `g` flag.

### Concurrent builds of the same locale race

Each build starts by deleting the locale directory, so two overlapping runs leave a
half-written tree — pages missing while both runs report success. Caught by URL parity.
Never build the same locale twice concurrently.

---

## Verification

### Coverage above 100%

Numerator and denominator used different page sets (one counted every segment file,
the other only sitemap pages). A percentage that can exceed 100 is a broken measurement,
not a good result.

### Coverage is not completeness

The single most important lesson. Coverage answers *"how much of what I extracted did I
translate?"* — it is structurally incapable of seeing text the extractor never offered.

Gate 6 answers the real question by comparing built output against the source page and
failing on strings that were never translation candidates. It must **not** fail merely
because a string is identical in both languages: `e-Learning`, `PowerPoint (.PPT)` and
`Google Translate PDF` are correct unchanged. Report those separately as "identical but
offered".

---

## Operating the pipeline

- **`nohup … &` does not survive a tool-call shell.** Use the harness's background
  mechanism. A killed run loses everything since the last checkpoint.
- **macOS ships `openrsync`**, which rejects `--info=progress2` by printing usage and
  **exiting 0**. The sync silently transfers nothing. Verify destination state.
- **`pgrep -f 'script.sh'` matches the polling shell itself** → the waiter waits forever.
  Poll a state file, or match interpreter + script path.
- **Running the same expensive command twice in one line** (once to count, once to grep)
  doubles a 20-minute build. Redirect to a file and inspect the file.
