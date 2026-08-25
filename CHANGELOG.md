# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.5.0] — 2026-08-25

### Added

- **The repo is now a Claude Code plugin, not only a skill.** A `.claude-plugin/plugin.json`
  manifest gives it the name, version, description and licence the plugin directory needs in
  order to list it. The plugin is named `conveythis-translator`, so the skill is invoked as
  `/conveythis-translator:translate-site`

- **README section on installing it as a plugin**, covering the community-marketplace install,
  `claude --plugin-dir` for a local clone, and the `~/.claude/skills/` directory-plugin path

### Changed

- **`SKILL.md` moved from the repo root to `skills/translate-site/SKILL.md`.** This was forced,
  not cosmetic. The plugin documentation states that a single-skill plugin may keep `SKILL.md` at
  the plugin root, but on Claude Code 2.1.126 that skill is never discovered — verified against
  three variants (manifest present, manifest absent, and `"skills": "./"`), all of which loaded
  no skill at all. The conventional `skills/<name>/SKILL.md` layout loads correctly

- **`references/` moved into `skills/translate-site/references/`, so the skill directory is
  self-contained.** This keeps both install paths working from one copy: as a plugin, and as a
  plain personal skill symlinked into `~/.claude/skills/`. The reference links in the skill stay
  plain relative paths; only `LICENSING.md` and `i18n.config.example.json`, which remain at the
  repo root, are addressed as `${CLAUDE_PLUGIN_ROOT}/…`

- Contrary to what an earlier draft of this entry claimed, a directory in `~/.claude/skills/`
  carrying a `.claude-plugin/plugin.json` is **not** auto-loaded as a plugin on 2.1.126 —
  `claude plugin list` reports nothing installed. The README now documents symlinking the skill
  directory itself, which is verified to work

- The skill's frontmatter `name` is now `translate-site` rather than `claude-translator`, so the
  namespaced invocation does not read `/conveythis-translator:claude-translator`

- `package.json` `files` ships `.claude-plugin/` and `skills/` in place of the root `SKILL.md`

### Fixed

- **The Pipeline commands in `SKILL.md` pointed at the wrong directory.** They read
  `node scripts/extract.mjs`, but `claude-translator init` scaffolds into `scripts/i18n/`
  (its `--dir` default), as the README has always shown correctly. Every command in that block
  would have failed with `Cannot find module` for anyone following the skill rather than the
  README

- **Setup instructions assumed a hand-clone.** The skill hardcoded
  `~/.claude/skills/claude-translator/bin/claude-translator.mjs`, a path that does not exist for
  a plugin install. It now leads with `npx claude-translator init` and offers
  `"${CLAUDE_PLUGIN_ROOT}"/bin/claude-translator.mjs` as the offline fallback, which resolves to
  wherever the plugin actually landed

### Verified

- `claude plugin validate .` passes with no errors and no warnings on Claude Code 2.1.126.
  Note that this version rejects both `displayName` and `"skills": ["."]`, which the current
  plugin reference documents — neither is used here
- Loaded through `claude --plugin-dir`, the skill is discovered and namespaced correctly. The
  check used a uniquely renamed copy of the skill, so a same-named skill already installed in
  `~/.claude/skills/` could not be mistaken for it
- `${CLAUDE_PLUGIN_ROOT}` resolution and the corrected setup line were confirmed end to end:
  running the documented command against a throwaway project scaffolds `scripts/i18n/` with all
  nine scripts, `i18n.config.json`, and the `.gitignore` entries
- Both install paths were checked against the final layout: the plugin loads through
  `--plugin-dir`, and the skill directory symlinked into `~/.claude/skills/` is discovered too
- `npm run check` and `npm test` (39 tests) pass unchanged; `npm pack` ships
  `.claude-plugin/plugin.json`, the skill and its references

## [1.4.0] — 2026-08-25

### Changed

- **The `openai` adapter's default model is now `gpt-5.6-luna`**, replacing `gpt-4o-mini`.
  OpenAI has not published a shutdown date for `gpt-4o-mini`, but the rest of that generation
  has one — `gpt-4o-2024-05-13`, `o1`, `o3-mini` and `gpt-4.1-nano` all retire 2026-10-23 — and
  a 2024 model is no longer a sensible default for new projects. Anyone pinning `gpt-4o-mini` in
  `i18n.config.json` is unaffected

- **Reasoning models no longer receive `temperature`.** This was a required change, not a
  cosmetic one: `gpt-5.6-luna` rejects any temperature but `1`, so the model swap alone would
  have returned `400 Unsupported value: 'temperature' does not support 0.2 with this model` on
  every single request. Model ids matching `^gpt-5` or `^o[1-9]` now get no sampling parameter
  and `reasoning_effort: 'none'` instead — bulk segment translation is a low-reasoning task, the
  same argument `anthropic.mjs` makes when it pins its thinking tiers to `effort: 'low'`.
  The match is anchored, so a local model whose id merely contains `gpt-5` keeps `temperature`

### Added

- **Automatic recovery from an unsupported request parameter.** A new optional adapter hook,
  `unsupportedParam(status, errText)`, names one parameter the server rejected; `translate.mjs`
  drops it and retries, exactly as it already steps down the `response_format` ladder. Each
  parameter is dropped at most once, so it cannot loop. This is the general form of the bug
  above — the next reasoning model with a new restriction now degrades instead of failing a run

  The hook is deliberately hard to trigger: the error must read as a capability complaint *and*
  name a parameter the adapter actually sends. A plain `400 model not found` is still a failure,
  because an adapter that quietly strips its own request is worse than one that stops

- Seven contract tests covering the reasoning-model rule, the `gpt-4o-mini` regression, local
  model ids, the `drop` set, and `unsupportedParam` — including that it and `unsupportedJsonMode`
  never both claim the same error. 39 tests total

### Verified

- `gpt-5.6-luna` translated the same 98-unit site into Russian live: 3,450 / 2,876 tokens,
  **0 failed units**, six of six gates, 0 SEO findings, and no fallback needed — the proactive
  rule was correct up front. Its output shares only 21% of units with the `gpt-4o-mini` run,
  confirming the new default actually took effect. `unsupportedParam` was separately checked
  against a real 400 from the live API rather than a paraphrase of one. The Anthropic and Gemini
  adapters were re-run unchanged to confirm the `translate.mjs` change disturbed neither

## [1.3.0] — 2026-08-25

### Added

- **`npx claude-translator init`** — a scaffolder that replaces the four manual install
  steps. Copies the pipeline into `scripts/i18n/` (or `--dir`), writes `i18n.config.json`,
  declares `parse5`, and appends the derived `i18n/` paths to `.gitignore`. It never
  overwrites without `--force` and prints every path it touched
- `--help`, `--version`, `--dir`, `--force`
- **12 CLI contract tests** (`npm test`) covering the refusal to install outside a Node
  project, idempotency, `--force`, `--dir`, appending rather than replacing an existing
  `.gitignore`, and that `package.json` "files" actually ships what `init` copies
- CI now packs the tarball, installs it into a scratch project and runs `init`, so a
  broken published package fails the build rather than a user's first command

### Changed

- `parse5` moved from `dependencies` to `devDependencies`. Nothing in the published
  package needs it at runtime — the CLI only copies files — so `npx` no longer downloads
  it. A clone plus `npm install` is unaffected
- `package.json` gained a `files` allowlist, so the tarball carries the scripts,
  references, `SKILL.md` and the example config, and nothing else

### Verified

- **All three provider adapters called for real, for the first time** (2026-08-25). Until now
  every adapter had only ever been exercised by the offline contract tests in
  `scripts/providers/providers.test.mjs` — which prove the request we *build*, and cannot prove
  the request a server *accepts*. Each adapter translated the same 98-unit, 1,381-word site into
  Russian at its shipped default model, with `i18n/tm/ru.json` deleted between runs so that no
  provider could silently reuse another's translations and report a success without calling
  anything:

  | Adapter | Model | Tokens in/out | Cost | Failed units | Gates | SEO audit |
  | --- | --- | --- | --- | --- | --- | --- |
  | `anthropic` | `claude-haiku-4-5` | 4,315 / 4,130 | $0.025 | 0 | 6/6 | 0 findings |
  | `gemini` | `gemini-2.5-flash-lite` | 3,412 / 3,611 | $0.002 | 0 | 6/6 | 0 findings |
  | `openai` | `gpt-4o-mini` | 3,453 / 2,855 | not priced by design | 0 | 6/6 | 0 findings |

  All three passed on the first attempt and no adapter needed changing. Specifically confirmed
  live: Anthropic's `output_config.format` structured-output shape is accepted and Haiku 4.5
  correctly receives `temperature` and no `effort`; both non-default model ids still exist; and
  Cyrillic round-trips with every `<0>…</0>` placeholder intact across the 12 units that carry
  inline markup, with the `doNotTranslate` glossary holding the brand name in all 10 units
  containing it.

  The README's provider table now carries a *last verified* date per adapter, so a retired model
  id shows up as staleness rather than as a first-time user's unexplained 404.

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

[1.3.0]: https://github.com/ConveyThis/claude-translator/releases/tag/v1.3.0
[1.2.0]: https://github.com/ConveyThis/claude-translator/releases/tag/v1.2.0
[1.1.0]: https://github.com/ConveyThis/claude-translator/releases/tag/v1.1.0
[1.0.0]: https://github.com/ConveyThis/claude-translator/releases/tag/v1.0.0
