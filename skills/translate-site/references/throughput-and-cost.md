# Throughput and cost

How to budget a run, and how to make it finish in hours rather than days.

---

## Where the savings come from

Both levers below apply whichever provider you use, and they matter more than the choice of
provider: deduplication routinely cuts the bill by an order of magnitude, which is a bigger
factor than the 10x between Gemini and Claude.

**Deduplication is the largest lever, by far.** Header, footer, navigation and cross-link
blocks repeat on every page — a single string can occur hundreds of times across a site.
Translate each unique string once and reuse it everywhere.

On a content site the collapse from *segment occurrences* to *unique units* is typically an
order of magnitude. `extract.mjs` prints both numbers; the ratio between them is the factor
by which your API bill shrinks.

**Incrementality is the second.** The memory is keyed by SHA-1 of the source unit, so
editing one page changes only the hashes it touched. A re-run after a content edit
translates those and reuses everything else — usually cents. A full re-translation happens
only if the memory is deleted, which is why `i18n/tm/` belongs in version control.

## Budgeting

Estimate from **tokens**, not pages:

```
source tokens ≈ unique-unit words × 1.3
output tokens ≈ source tokens × script factor
```

Script factor, roughly:

| Target script | Output tokens vs source |
| --- | --- |
| Latin (es, fr, de, pt…) | 1.2 – 1.5× |
| Cyrillic, Greek, Arabic, Hebrew | 1.8 – 2.2× |
| Devanagari, Thai, Bengali, Tamil | 3 – 4× |
| CJK | 1.0 – 1.5× |

Then apply your provider's per-million rate. The default is Claude, which is **not** the
cheapest option — it is the one the project is named for, and the tradeoff is worth stating
plainly rather than burying.

Rates checked 2026-08-25, USD per million tokens:

| Provider / model | In | Out | A mid-sized site, 20 locales |
| --- | --- | --- | --- |
| `gemini-2.5-flash-lite` | 0.10 | 0.40 | **~$2.40** |
| `claude-haiku-4-5` *(default)* | 1 | 5 | **~$30** |
| `claude-sonnet-5` | 3 | 15 | ~$90 |
| `claude-opus-5` | 5 | 25 | ~$150 |
| a local model via Ollama | — | — | **$0** |

Those totals assume ~150k unique source words and Latin-script targets; scale by the table
above for other scripts. Treat them as order-of-magnitude, not a quote.

**So: money is a constraint here in a way it was not before 1.2.** If cost matters more
than the last few percent of idiom, one line moves you:

```json
{ "provider": "gemini", "model": "gemini-2.5-flash-lite" }
```

and one line moves you to free, at the price of running the model yourself:

```json
{ "provider": "openai", "apiBaseUrl": "http://localhost:11434/v1", "model": "qwen2.5:14b" }
```

Whatever you pick, **review time is still the real constraint** — the pilot in the
sequence below exists because layout problems and script-specific defects cost more to
find late than any of these numbers.

The Batch API halves cost on providers that offer one and runs asynchronously. Worth it
for a full rollout; not worth the added latency for a 3-locale pilot.

## Batching

- Default 40 units per request.
- Split **only** on failure — truncated JSON or a safety block. Pre-emptively shrinking
  batches just multiplies request count for no benefit.
- Use `--batch 6` when re-translating units that already failed once: those are the long,
  awkward ones that hit output limits.
- Smaller and local models want smaller batches. 40 units is tuned for hosted frontier
  models; a 7B running on a laptop is more reliable at 8–10.

## Parallelism

Running one locale at a time is the slowest possible arrangement. Split the locale list
across several concurrent streams:

```bash
node scripts/translate.mjs --lang es,it,pl,nl --concurrency 8 &
node scripts/translate.mjs --lang fr,de,tr,sv --concurrency 8 &
node scripts/translate.mjs --lang ja,ko,zh,th --concurrency 8 &
```

Wall-clock drops close to linearly with stream count. Around 32 concurrent requests has run
cleanly without rate-limit errors on a paid tier; back off if you see 429s — the retry logic
handles them, but they waste time. A local model is the exception: concurrency past what the
GPU can hold makes it slower, not faster, so start at 2 and measure.

Two rules for splitting:

- **Round-robin, don't chunk.** Each stream should mix high- and low-value locales so a
  partial run still covers what matters.
- **Order by traffic, not alphabetically.** If the run is interrupted at 60%, you want the
  60% that earns.

## Suggested sequence

1. **Pilot 3–4 locales** — one LTR, one RTL, one CJK, and one long-word language
   (German, Finnish). This surfaces script-specific layout and heuristic problems while
   they are still cheap to fix.
2. Review, fix, get sign-off.
3. **Bulk run** the remainder in parallel streams, traffic-ordered.
4. `verify` and `audit-seo` **once** across everything at the end.

The pilot is not ceremony. RTL panel clipping, CJK length-ratio false positives and
font-fallback layout shift all appear only when those scripts are first built.
