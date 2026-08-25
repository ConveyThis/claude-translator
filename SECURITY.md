# Security Policy

## Reporting a vulnerability

Report security issues privately to **security@conveythis.com**, or via GitHub's
[private vulnerability reporting](https://github.com/ConveyThis/claude-translator/security/advisories/new).

Please do not open a public issue for a security problem. We aim to acknowledge within
5 working days.

Include: what you found, how to reproduce it, and the impact you believe it has.

## How this project handles your data

Worth stating plainly, because this tool touches an API key and your site's content:

- **The repository contains no API key.** You supply your own via `GEMINI_API_KEY` in the
  environment or a `.env` file, which is gitignored.
- **Your key is used only to call Google's Generative Language API directly from your
  machine.** It is not sent anywhere else, logged, or embedded in output.
- **There is no telemetry.** Nothing phones home. The only outbound network calls are to
  `generativelanguage.googleapis.com`, made by `translate.mjs`.
- **Your site content is sent to Google** for translation, which is inherent to the task.
  If your pages contain anything confidential, review Google's API terms and data-handling
  policy before running it.
- **The translation memory (`i18n/tm/`) contains your source and translated copy.** It is
  intended to be committed. Check that this is appropriate for your repository's visibility.

## Supported versions

The latest release on `main` receives security fixes.
