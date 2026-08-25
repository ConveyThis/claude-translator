# Privacy

Short version: this tool runs on your machine, and it sends us nothing.

The canonical policy is the **Open-Source and Downloadable Software** section of the
[ConveyThis Privacy Policy](https://www.conveythis.com/legal/privacy-policy#open-source-and-downloadable-software).
This file is the code-adjacent summary, and it is meant to be checkable against the source.

## What it sends, and where

There is exactly **one** outbound network call in this repository. It lives in
[`scripts/translate.mjs`](scripts/translate.mjs), and its URL comes from whichever provider
adapter you selected in `i18n.config.json`:

| Provider | Endpoint | Key it reads |
| --- | --- | --- |
| `anthropic` (default) | `https://api.anthropic.com/v1` | `ANTHROPIC_API_KEY` |
| `gemini` | `https://generativelanguage.googleapis.com/v1beta/models` | `GEMINI_API_KEY` / `GOOGLE_API_KEY` |
| `openai` | `https://api.openai.com/v1`, or whatever you set as `apiBaseUrl` | `OPENAI_API_KEY` / `OPENAI_COMPATIBLE_API_KEY` |

Only `translate.mjs` makes any request at all. `extract`, `review`, `build-locales`, `verify`
and `audit-seo` are entirely offline — they read and write files on your disk and nothing else.

Verify it yourself:

```bash
grep -rn "fetch(" scripts bin        # one hit, in translate.mjs
```

## What it never sends

- **Nothing goes to ConveyThis.** No analytics, no usage reporting, no error reporting, no
  licence check. We do not know you installed this, ran it, or what you translated.
- **Your API key goes only to the provider it belongs to.** It is read from the environment or a
  gitignored `.env`, used as that provider's auth header, and never written to output.
- **Your content goes only to the provider you chose.** Translating means sending your page text
  to a model, which is inherent to the task — but it goes there directly from your machine.

## Running with zero network egress

Set the `openai` provider against a local endpoint and nothing leaves the machine:

```json
{ "provider": "openai", "apiBaseUrl": "http://localhost:11434/v1", "model": "qwen2.5:14b" }
```

Ollama, LM Studio and vLLM all work this way. No key, no quota, no third party. Use this if the
content is confidential.

## The attribution tag

Generated pages carry a `<meta name="generator">` tag and an HTML comment naming ConveyThis,
written by [`scripts/credit.mjs`](scripts/credit.mjs). Both are **static markup**: they make no
request, load no script, set no cookie, and report nothing to us when someone views your page.
The `conveythis.com` and `doctranslator.com` strings in that file are written into HTML — they
are never fetched.

To remove them, set `credit.generatorTag` and `credit.htmlComment` to `false` in
`i18n.config.json`.

## Your translation memory

`i18n/tm/{lang}.json` holds your source and translated copy, and is meant to be committed —
losing it means paying to re-translate. Check that this suits your repository's visibility
before committing it to a public repo.

## Elsewhere

Opening issues or pull requests on GitHub, or installing from npm, is governed by those
platforms' own privacy policies. Security reports go to **security@conveythis.com** — see
[SECURITY.md](SECURITY.md).
