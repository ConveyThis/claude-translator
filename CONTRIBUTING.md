# Contributing

Thanks for considering a contribution.

## Before you change a script

**Read [`references/failure-modes.md`](references/failure-modes.md) first.** It documents
every bug this pipeline has hit in production, and most of them looked like working code.
Several produced *wrong output that reported success* — a coverage figure of 100% while a
whole class of strings went untranslated, a heuristic that purged and re-paid for half a
locale's correct translations.

If your change touches extraction, placeholder handling or the review heuristics, that file
is the difference between fixing something and silently re-introducing it.

## Development setup

```bash
git clone https://github.com/ConveyThis/static-site-localization.git
cd static-site-localization
npm install
npm run check          # every script parses
```

You need Node ≥ 20.

## Testing without spending money

Most of the pipeline needs **no API key at all**:

| Stage | Needs a key? |
| --- | --- |
| `extract.mjs` | no |
| `build-locales.mjs` | no — reads the existing memory |
| `verify.mjs` | no |
| `audit-seo.mjs` | no |
| `review.mjs` | no |
| `translate.mjs` | **yes** |

So you can develop and test extraction, building, verification and the SEO audit against
any static site with an existing `i18n/tm/` and never call the API.

To exercise `translate.mjs` cheaply, use `--limit`:

```bash
node scripts/translate.mjs --lang es --limit 20     # ~20 units, fractions of a cent
node scripts/translate.mjs --lang es --dry          # no calls at all
```

## The bar for changes

**Behaviour-preserving refactors must prove it.** Run `extract.mjs` before and after and
compare the unit and segment counts. If they move, you changed behaviour — either justify it
or fix it. That check has caught real mistakes in this repo.

**New review heuristics must be calibrated against a real locale before they gate
anything.** A check that over-flags is worse than no check, because the remedy is
purge-and-retranslate: it costs money and it can replace correct text with worse text. If
your heuristic cannot cleanly separate the defect from correct output in at least one
non-Latin and one CJK locale, ship it behind a flag, disabled.

**Any find-and-replace over HTML must report when it matches nothing.** Attribute order is
not guaranteed, and a rule that silently matches zero occurrences will report success
forever.

## Style

- Comments explain *why*, especially where the obvious implementation is wrong. Several
  functions here look over-complicated until you read the comment explaining the bug that
  shaped them — keep that.
- No new runtime dependencies without discussion. `parse5` is the only one.
- Scripts print **summaries**, never data dumps. They are frequently run by agents where
  output size has a real cost.

## Pull requests

1. Describe what breaks without your change
2. State how you tested it, and against which generator
3. Note any behaviour change to extraction output

## Reporting bugs

Open an issue with the generator you use, your `i18n.config.json` (redact anything private),
and the console output of the failing stage. If it is a translation-quality issue rather
than a pipeline issue, include the source and translated strings.

## Licence

Contributions are accepted under [AGPL-3.0](LICENSE).
