# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-08-17

First public release. Extracted from a production rollout that localized a content site
into dozens of languages.

### Added

- `extract.mjs` — block-level translation units with byte offsets; inline markup tokenised
  as numbered placeholders
- `translate.mjs` — Gemini translation into a hash-keyed memory, with batch splitting on
  truncated JSON and safety blocks, network-level retry, and periodic checkpointing
- `review.mjs` — translation quality heuristics: placeholder integrity, word overlap,
  script-aware length bounds, Latin-script ratio
- `build-locales.mjs` — byte-range substitution plus per-locale identity (`lang`, `dir`,
  canonical, hreflang, JSON-LD, `og`, internal links)
- `verify.mjs` — six gates including "text never offered for translation", which catches
  extraction holes that coverage metrics structurally cannot see
- `audit-seo.mjs` — exhaustive canonical / hreflang / JSON-LD / sitemap audit over every
  page rather than a sample
- `finalize.sh` — per-locale convenience cycle; purging is opt-in behind `--purge`
- `config.mjs` — single configuration surface, making the pipeline generator-agnostic
- Reference documentation covering failure modes, quality-review calibration, throughput
  and cost, and adapting to other static site generators
- `SKILL.md`, so the repository can be installed directly as a Claude Code skill

[1.0.0]: https://github.com/ConveyThis/static-site-localization/releases/tag/v1.0.0
