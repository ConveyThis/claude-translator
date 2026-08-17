#!/usr/bin/env bash
# Finalise one or more locales whose translation memory is complete.
#
#   ./scripts/finalize.sh fr id it              # fill gaps, review, build
#   ./scripts/finalize.sh --purge fr id it      # ALSO purge + re-translate flagged units
#
# Per locale, in order:
#   1. fill any gaps left by failed batches (incremental — only missing hashes)
#   2. review and report the flag rate
#   3. [--purge only] purge flagged units and re-translate them at a smaller batch size
#   4. build the locale's pages
#
# ── Why --purge is opt-in ────────────────────────────────────────────────────
# Purging is destructive: it deletes translations and pays to regenerate them, and the
# replacement can be WORSE. Observed in practice — a handful of postal-address blocks were
# flagged as "untranslated / high-overlap" (false positives, since addresses are mostly
# proper nouns). Auto-purging them replaced correct localised text with the source
# language: "Correo electrónico" came back as "Email:". The review flags were right that
# the strings looked odd, and wrong that they needed fixing.
#
# So: READ the review output, confirm the flags are real, and only then pass --purge.
# See references/quality-review.md.
#
# Verification is deliberately NOT run here — verify.mjs is cheaper once over all
# locales at the end than once per locale.
set -uo pipefail

PURGE=0
if [ "${1:-}" = "--purge" ]; then
  PURGE=1
  shift
fi

if [ "$#" -eq 0 ]; then
  echo "usage: finalize.sh [--purge] <locale>..." >&2
  exit 1
fi

# Resolve sibling scripts regardless of where this lives in the project,
# and run from the project root so config + node_modules resolve.
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "${I18N_ROOT:-$(cd "$DIR/../.." && pwd)}"

for lang in "$@"; do
  echo "──────── $lang ────────"

  node "$DIR"/translate.mjs --lang "$lang" --concurrency 4 2>&1 | tail -2

  node "$DIR"/review.mjs --lang "$lang" 2>&1 | head -2 | tail -1

  if [ "$PURGE" -eq 1 ]; then
    node "$DIR"/review.mjs --lang "$lang" --purge 2>&1 | tail -1
    node "$DIR"/translate.mjs --lang "$lang" --concurrency 3 --batch 6 2>&1 | tail -1
    node "$DIR"/review.mjs --lang "$lang" 2>&1 | head -2 | tail -1
  fi

  node "$DIR"/build-locales.mjs --lang "$lang" 2>&1 | tail -1
done
