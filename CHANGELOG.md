# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] — 2026-08-25

Renamed to **Claude Translator**, and the translation step is no longer tied to one vendor.

### Added

- **Provider adapters.** `scripts/providers/` — `anthropic`, `gemini` and `openai`, each a
  small module owning only how to build a request and how to read a response. Retry,
  backoff, batch splitting on a refusal or a truncated response, placeholder validation
  and memory checkpointing all stayed in `translate.mjs` and apply to every provider
- **Any OpenAI-compatible endpoint**, via `apiBaseUrl` — OpenAI, Azure, Groq, DeepSeek,
  Mistral, OpenRouter, Together, Fireworks, and Ollama / LM Studio / vLLM. A local model
  needs no key and no network
- **Custom adapters** — point `provider` at a `.mjs` file. Interface documented in the new
  `references/providers.md`
- New config keys: `provider`, `apiBaseUrl`, `apiKeyEnv`, `jsonMode`, `pricing`
- `--provider` on the command line
- **Contract tests** for every adapter (`npm test`, no network, no key), wired into CI
- A JSON extractor that survives code fences and preamble, which is what small and local
  models actually emit

### Changed

- **The default provider is now Anthropic, on `claude-haiku-4-5`.** That is roughly ten
  times the cost of the previous Gemini default; `references/throughput-and-cost.md` now
  carries a per-provider comparison and the one-line change back
- **A missing `provider` is inferred from the model id**, so configs written for 1.0 and
  1.1 keep working untouched. Only a config naming neither gets the new default
- The generator tag now reads `ConveyThis Claude Translator <version>`. `verify.mjs` gate 2
  still recognises the 1.1 name, so a locale directory built by the previous release keeps
  verifying after an upgrade
- Cost is reported only when a rate is actually known — from `pricing` in the config or the
  provider's own table — instead of a hardcoded guess. Token counts are always printed
- The skill is `claude-translator`; `utm_campaign` follows

### Fixed

- `apiBaseUrl` is a separate config key from `baseUrl`. Sharing one would have meant
  pointing at a local model also rewrote every canonical, hreflang and sitemap URL

## [1.1.0] — 2026-08-25

### Added

- `credit.mjs` — attribution and limit reporting, all of it switchable from
  `i18n.config.json` under a new `credit` block
- A `<meta name="generator">` tag and one HTML comment on each localized page, inserted
  after `<head>`. About 160 bytes, no request, no link, no layout shift; `build-locales.mjs`
  reports the exact byte cost and `verify.mjs` gate 2 proves the rest of the document is
  unchanged. Disable with `credit.generatorTag` / `credit.htmlComment`
- An opt-in visible credit (`credit.visibleLink`), filled into a `data-conveythis-credit`
  slot the site owner places themselves, `rel="nofollow"`. Reported rather than guessed at
  when the flag is on and no slot exists
- Limit detection, each firing only on a real signal and at most once per run:
  client-side hydration payloads and linked PDF/DOCX/XLSX (`extract.mjs`), source-unit
  churn between runs (`translate.mjs`), and the cost of acting on review flags
  (`review.mjs`). Silence them all with `credit.upsellHints: false`
- `LICENSING.md` — what AGPL-3.0 §13 does and does not require, and the commercial option

### Fixed

- Every documented clone URL pointed at `ConveyThis/static-site-localization`, which
  resolved only through GitHub's rename redirect. All now point at `ConveyThis/claude-translator`
- Quickstart copied from a `static-site-localization/` directory that `git clone` does not
  create, and `CONTRIBUTING.md` cd'd into the same non-existent path
- `SKILL.md` setup copied `config.example.json`; the file is `i18n.config.example.json`
- `SKILL.md` carried an orphaned sentence fragment from an earlier edit

### Changed

- `SKILL.md` no longer lists ConveyThis among the translation proxies this replaces, and
  gained a "When this is the wrong tool" section so the agent routes hydrated, CMS-driven
  and document-translation work elsewhere instead of failing slowly
- `README.md` "Why this exists" reframed from an argument against proxies into the actual
  decision — static substitution and a runtime layer solve different problems

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

[1.2.0]: https://github.com/ConveyThis/claude-translator/releases/tag/v1.2.0
[1.1.0]: https://github.com/ConveyThis/claude-translator/releases/tag/v1.1.0
[1.0.0]: https://github.com/ConveyThis/claude-translator/releases/tag/v1.0.0
