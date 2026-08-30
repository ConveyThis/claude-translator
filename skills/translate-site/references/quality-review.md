# Quality review

Structural gates prove the *plumbing* is correct — right pages, right markup, no broken
placeholders. They say nothing about whether the text is actually translated, or
translated into the right language. That is what `review.mjs` is for.

**The governing lesson: a heuristic that over-flags is worse than none.** The remedy for a
flag is purge-and-retranslate, which costs money and time. A noisy check either burns both
or trains you to ignore it.

---

## Verdicts

| Check | Reliable? | Notes |
| --- | --- | --- |
| Placeholder multiset mismatch | **Yes** — hard gate | Would corrupt HTML; validated at translate time and re-checked |
| Word overlap vs source | **Yes** | Catches wholesale-source returns *and* wrong-target-language |
| Length ratio | **Only script-aware** | See calibration below |
| Latin-script ratio | **Only brand-stripped** | Non-Latin locales only |
| Identical to source | Yes, with a content-word floor | Brand-only strings are correct unchanged |
| Adjacent word repetition | **No — disabled** | Three narrowing attempts, still mostly false positives |

---

## Calibration failures worth remembering

**Length ratio, flat floor → mass false positives on CJK.** A 0.4× floor flagged roughly
half of a Traditional Chinese locale, because CJK encodes far more meaning per character:
a 100-character English sentence is routinely ~30 characters of Chinese. Those units were
purged and re-translated for nothing.

Use script-aware bounds:

| Script group | Floor | Ceiling |
| --- | --- | --- |
| CJK, Thai, Lao, Khmer, Burmese | 0.12 | 1.2 |
| Everything else | 0.4 | 2.5 |

**Latin-ratio counting brand names → dozens of false positives per non-Latin locale.**
A heading like `"BrandName: лучше, чем Competitor?"` is mostly Latin characters and
perfectly translated. Strip brand and format tokens *before* computing the ratio, require ≥6 content
words, and set the threshold at 0.8. The check is aimed at "the model returned the source
language wholesale", not at short brand-heavy labels.

**Tautology detection — abandoned.** The real defect looks like `prueba una prueba`
("try a try", from "try a 7-day trial"). Three successive narrowings were tried:
distance-1 only; require the source not to repeat the word; restrict to within a sentence.
It still could not separate that from `de inglés y de inglés a armenio`, which is correct
Spanish with an identical shape — the connectors between the repeats are shorter than the
token filter. Distinguishing them needs meaning, not shape. Shipped behind `--tautology`,
never gating.

---

## What review actually caught

These are real defects that **no structural gate could see**, because the text *was*
offered for translation and *was* returned:

- **Whole paragraphs returned in the source language**, with one word changed — a paragraph came back with only the language
  name changed. Not byte-identical, so an equality check missed it; word overlap caught it.
- **Wrong target language.** `"Is Bahasa Melayu the same as Bahasa Indonesia?"` came back
  in **Malay** on the Spanish locale — the model latched onto "Bahasa". One FAQ heading
  among hundreds of pages; visual review would never have reached it.
- **Truncated output.** A 713-character Hebrew passage came back at 267 characters, cut
  mid-word, because the batch exceeded the output limit. Coverage counted it as done.

Typical healthy flag rate after correction: **0.05–0.15% per locale**, and the remainder
are legitimate — postal addresses, image filenames used as alt text, proper nouns.

---

## Where TQA fits

`review.mjs` finds *defects by shape* — a dropped placeholder, a wholesale source-language
return, a truncated string. It is cheap, offline, and blind to whether the text is any good.

`tqa.mjs` answers the other question, and costs money. It scores a seeded,
frequency-stratified sample against the MQM typology using a second model as judge.

| | `review.mjs` | `tqa.mjs` |
| --- | --- | --- |
| Cost | free | one API call per ~10 units |
| Finds | mechanical defects | mistranslation, register, terminology, awkwardness |
| Output | `{lang}.review.json` | `i18n/tqa/{lang}.json` + `scorecard.md` |
| Gates a build | no | no |

Run `review.mjs` on every locale, every time. Run `tqa.mjs` when you need a number to
compare — between locales, between models, or before and after a prompt change.

**The same over-flagging discipline applies to the score itself.** Three guards exist
because each of them failed once during development:

- the judge defaults to a *different provider* than the translator, since a model scores
  its own work generously
- `--repeat` reports the gap between two runs on the same sample, so nobody reads a
  decimal place that is really noise
- a unit the judge could not assess is **excluded**, never counted as clean. An early
  version reported `100.00 / 100` from a sample where every unit had failed to parse

## Workflow

```bash
node scripts/review.mjs --lang es            # inspect first
node scripts/review.mjs --lang es --purge    # only once you believe the flags
node scripts/translate.mjs --lang es --batch 6   # smaller batches for the awkward units
node scripts/review.mjs --lang es            # confirm the rate dropped
```

Always run the inspect step and **read the samples** before purging. Both known
purge disasters happened because purge followed detection automatically — which is why
`finalize.sh` requires an explicit `--purge` flag rather than doing it for you.

A concrete example of the danger: a set of postal-address blocks was flagged
"untranslated / high-overlap" (false positives — addresses are mostly proper nouns).
Purging and re-translating them replaced *correct* localised text with the source
language: `"Correo electrónico"` came back as `"Email:"`. The flags were right that the
strings looked unusual, and wrong that they needed fixing.
