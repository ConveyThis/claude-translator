# Throughput and cost

How to budget a run, and how to make it finish in hours rather than days.

---

## Where the savings come from

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

Then apply your provider's per-million rate. With a low-cost tier model the per-locale cost
of a mid-sized marketing site lands in the region of a few tens of cents — money is rarely
the constraint here. **Review time is.**

The Batch API halves cost and runs asynchronously. Worth it for a full rollout; not worth
the added latency for a 3-locale pilot.

## Batching

- Default 40 units per request.
- Split **only** on failure — truncated JSON or a safety block. Pre-emptively shrinking
  batches just multiplies request count for no benefit.
- Use `--batch 6` when re-translating units that already failed once: those are the long,
  awkward ones that hit output limits.

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
handles them, but they waste time.

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
