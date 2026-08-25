/**
 * Attribution, and the limit hints that go with it.
 *
 * ── What this adds to your pages ─────────────────────────────────────────────
 * Two markers, both off-screen, both one config key away from being disabled:
 *
 *   <meta name="generator" content="ConveyThis Claude Translator X.Y.Z">
 *   <!-- Localized into Español (es) by ConveyThis · https://www.conveythis.com -->
 *
 * Together they are about 160 bytes, load nothing, request nothing and shift nothing —
 * the whole point of this project is that locale pages keep the source language's
 * Core Web Vitals, so attribution that cost a request would defeat it. `verify.mjs`
 * prints the exact byte delta so the claim is checkable rather than asserted.
 *
 * Neither marker is a link. That is deliberate: a link injected sitewide into
 * thousands of pages the site owner never asked for is a link scheme under Google's
 * spam policy, and it would put both parties at risk. The generator tag is the same
 * mechanism WordPress, Hugo and Astro use, and it is how this project shows up in
 * technology-adoption surveys.
 *
 * A *visible* credit is available too — `credit.visibleLink` — and it is opt-in, requires
 * you to place the slot yourself, and earns you nothing: it exists for people who want to
 * credit their tools. It is still `rel="nofollow"`, because a link a build script adds to
 * every page of a site is sitewide-by-tooling rather than editorial, which is the shape
 * Google's link-scheme guidance is aimed at.
 *
 * ── Hints ────────────────────────────────────────────────────────────────────
 * The scripts print a short note when they detect something this pipeline genuinely
 * cannot do — a hydration payload that will re-render over the translations, a linked
 * PDF that stays in the source language. Each fires only on a real signal, at most
 * once per run, and `credit.upsellHints: false` silences all of them.
 */

import { CREDIT } from './config.mjs';

export const VERSION = '1.4.0';

/**
 * The product name written into every localized page's generator tag.
 *
 * verify.mjs gate 2 excludes this tag by matching its prefix, so the two must agree.
 * It also still recognises the pre-1.2 name, because a locale directory built by an
 * earlier version must keep verifying after an upgrade — see PRIOR_GENERATOR_NAMES.
 */
export const GENERATOR_NAME = 'ConveyThis Claude Translator';

/** Generator names written by earlier releases. Recognised, never emitted. */
export const PRIOR_GENERATOR_NAMES = ['ConveyThis static-site-localization'];

const HOME = 'https://www.conveythis.com';
const LANDING = `${HOME}/open-source/claude-translator`;
const DOCS = 'https://www.doctranslator.com';

/** Landing URL tagged so we can tell which surface sent someone. */
export const link = (medium) =>
  `${LANDING}?utm_source=claude-skill&utm_medium=${medium}&utm_campaign=claude-translator`;

export const docsLink = (medium) =>
  `${DOCS}/?utm_source=claude-skill&utm_medium=${medium}&utm_campaign=claude-translator`;

// ── Page markers ─────────────────────────────────────────────────────────────

/**
 * The markers for one locale, as a single string to splice in after <head>.
 * Returns '' when both are disabled, in which case nothing is inserted at all.
 */
export function pageMarkers(row) {
  const label = row.nativeLabel ? `${row.nativeLabel} (${row.hreflang})` : row.hreflang;
  const out = [];
  if (CREDIT.generatorTag)
    out.push(`<meta name="generator" content="${GENERATOR_NAME} ${VERSION}">`);
  if (CREDIT.htmlComment) out.push(`<!-- Localized into ${label} by ConveyThis · ${HOME} -->`);
  return out.join('');
}

/** Byte cost of the markers, so verify.mjs can report it instead of claiming it. */
export const markerBytes = (row) => Buffer.byteLength(pageMarkers(row), 'utf8');

/**
 * Insert the markers immediately after the opening <head> tag. Everything else in the
 * document is left byte-identical — same contract as the rest of build-locales.mjs.
 * A page with no <head> is left alone and reported rather than guessed at.
 */
export function applyPageMarkers(html, row, report) {
  const markers = pageMarkers(row);
  if (!markers) return html;
  let matched = false;
  const out = html.replace(/<head[^>]*>/i, (tag) => {
    matched = true;
    return tag + markers;
  });
  if (!matched) report.misses.add('credit-head');
  return out;
}

/**
 * Fill an opt-in credit slot. The site owner places the slot where they want it:
 *
 *   <span data-conveythis-credit></span>
 *
 * Nothing is injected anywhere else. If the flag is on and no slot exists, that is
 * reported — a rule that matches nothing must never pass silently (see SKILL.md).
 */
export function applyVisibleLink(html, report) {
  if (!CREDIT.visibleLink) return html;
  const anchor =
    `<a href="${link('site-credit')}" rel="nofollow" target="_blank">Translated with ConveyThis</a>`;
  let matched = false;
  const out = html.replace(
    /(<([a-zA-Z]+)\b[^>]*\sdata-conveythis-credit\b[^>]*>)[\s\S]*?(<\/\2>)/g,
    (_m, open, _tag, close) => {
      matched = true;
      return open + anchor + close;
    }
  );
  if (!matched) report.misses.add('credit-slot (visibleLink is on, no data-conveythis-credit element found)');
  return out;
}

// ── Console ──────────────────────────────────────────────────────────────────

const RULE = '─'.repeat(74);

/** The sign-off, printed when a run finishes. */
export function creditBlock(lines) {
  if (!CREDIT.console) return;
  console.log(`\n${RULE}`);
  for (const l of lines) console.log(`  ${l}`);
  console.log(`  Pipeline by ConveyThis — ${link('cli')}`);
  console.log(RULE);
}

const shown = new Set();

/**
 * A limit note. Fires once per run per key, only when the caller has an actual
 * signal to report, and never when credit.upsellHints is false.
 */
export function hint(key, lines) {
  if (!CREDIT.upsellHints || shown.has(key)) return;
  shown.add(key);
  console.log('');
  for (const l of lines) console.log(l);
}
