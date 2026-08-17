---
name: static-site-localization
description: >
  Localize a static website into many languages by substituting translations into
  already-built HTML, without re-rendering. Ships six proven scripts (extract,
  translate, review, build, verify, SEO audit) plus the failure modes that cost real
  money to discover. Use when the user says "translate the site", "localize",
  "multi-language site", "i18n", "add languages", "translate all pages", or is
  replacing a translation proxy (ConveyThis, Weglot, Bablic) with self-hosted pages.
  Works with any static output: Astro, Next export, Hugo, Eleventy, Jekyll, plain HTML.
user-invocable: true
argument-hint: "[project-dir]"
license: AGPL-3.0
metadata:
  author: ConveyThis
  version: "1.0.0"
  category: i18n
---

# Static Site Localization

Turns a built site into N localized copies as **real static pages**, keeping Core Web
Vitals identical to the source language.

language on Lighthouse across LTR, RTL and CJK alike.

---

## The two decisions that define this approach

**1. Substitute into built HTML by byte offset. Never re-render.**

Each locale page is the source page with byte ranges spliced right-to-left. The document
is never re-serialised from a DOM, so inlined critical CSS, the LCP element, asset hashes
and the `width`/`height` attributes that hold CLS all carry over untouched. That is *why*
locale pages match the source on CWV rather than merely resembling it.

The alternative — real framework i18n — re-renders every page through the critical-CSS
step. Critical-CSS tooling is known to drop a small, unpredictable share of each page's classes,
which shows up as layout shift. Multiplying that across every locale is the biggest risk
available. **Do not take it**, and say so if asked
to "just use the framework's i18n".

**2. Translate blocks, not text nodes.**

A large share of a typical site's text nodes — around a fifth — are split by inline markup. Translating
`"With"` and `", you'll get…"` separately breaks grammar in any language that reorders
or inflects. The unit is the block element; inline tags become `<0>…</0>` placeholders
the model carries through and the builder restores.

---

## Setup

```bash
cp ~/.claude/skills/static-site-localization/scripts/*.mjs   <project>/scripts/
cp ~/.claude/skills/static-site-localization/scripts/*.sh    <project>/scripts/
cp ~/.claude/skills/static-site-localization/config.example.json <project>/i18n.config.json
cd <project> && npm i -D parse5          # the only dependency
```

Scripts run **from inside the project** so `parse5` and relative paths resolve. Edit
`i18n.config.json` — five keys cover everything; see `config.example.json`.

Add to `.gitignore`: `i18n/source.json`, `i18n/manifest.json`, `i18n/segments/`,
`i18n/tm/*.failures.json`, `i18n/tm/*.review.json`, and `i18n` in `.prettierignore`.
**Commit `i18n/tm/{lang}.json`** — the memory is the asset; losing it means paying for a
full re-translation.

## Pipeline

```bash
npm run build                                   # source language only
node scripts/extract.mjs                   # → i18n/source.json + segments/
node scripts/translate.mjs --lang es,fr    # → i18n/tm/{lang}.json  (needs GEMINI_API_KEY)
node scripts/review.mjs   --lang es        # quality flags
node scripts/build-locales.mjs --lang all  # → dist/{lang}/…
node scripts/verify.mjs   --lang all       # six gates
node scripts/audit-seo.mjs                 # canonical/hreflang/JSON-LD/sitemaps
```

`finalize.sh <locales…>` collapses the per-locale cycle (gap-fill → review → purge →
re-translate → build) into one command. Use it; running the five separately per locale
is the single biggest token waste in this workflow.

---

## Non-negotiable rules

**Never trust a coverage number.** Coverage measures translated-of-*extracted* and is
structurally blind to extraction holes. It has been observed reading **100% while every icon+label pair on the site was still
untranslated** — thousands of segments hidden by a single extraction bug. Gate 6 (`text never offered for translation`) exists solely to catch this. If gate 6
is non-zero, coverage is meaningless.

**Never purge-and-retranslate on an unproven heuristic.** Verify a sample by hand first.
A flat length-ratio floor can flag roughly **half of a CJK locale** — all of them correct,
because CJK encodes far more meaning per character. Purging those costs real money and time. See `references/quality-review.md`.

**Report rules that match nothing.** Any find-and-replace over HTML must count its
matches and warn on zero. Attribute order is not guaranteed — `<link href="…"
rel="canonical">` is as valid as `rel` first — and an order-dependent regex silently
matches nothing while reporting success.

**Verify server-side state, not exit codes.** Especially with rsync on macOS
(`openrsync` prints usage and exits **0** on an unsupported flag).

---

## Efficiency

**API calls** — budget from token volume, not page count:

- Dedup before translating: repeated blocks (headers, footers, cross-links) collapse to one
  unit each — typically an order-of-magnitude reduction in API calls
- Memory keyed by source-text hash → re-runs translate only what changed
- Batch ~40 units; split **only** on failure (truncated JSON, safety block)
- Order locales by organic traffic so partial progress is immediately useful
- Parallel streams cut wall-clock roughly linearly; 32 concurrent requests ran without
  rate-limit errors

**Tokens** — for the agent driving this:

- Scripts print summaries by design. **Never `cat` `source.json`, the memory, or the audit
  JSON** — they are megabytes of machine data with no reasoning value.
- Run `verify` and `audit-seo` once across all locales at the end, not per locale.
- When waiting on background work, poll a *count*, never a dump.
- `pgrep -f 'foo.sh'` matches the waiting shell itself → deadlock. Poll a state file or
  match the interpreter plus script.

---

## References

Load only when the situation calls for it:

- `references/failure-modes.md` — every bug hit, symptom → cause → fix. **Read before
  modifying any script**; most of these look like working code.
- `references/quality-review.md` — which review heuristics are reliable, which are not,
  and the calibration numbers behind that judgement.
- `references/throughput-and-cost.md` — batching, parallel streams, measured costs.
- `references/adapting-generators.md` — Astro, Next export, Hugo, Eleventy, plain HTML.

Deployment, CI guards and DNS cutover live in the companion skill
**`static-site-deploy`** — invoke it separately when shipping.
