#!/usr/bin/env node
/**
 * i18n step 2 — translate extracted units with the Gemini API into a translation memory.
 *
 *   node scripts/i18n/translate.mjs --lang es
 *   node scripts/i18n/translate.mjs --lang es,ru,pt-br --model gemini-3.5-flash-lite
 *   node scripts/i18n/translate.mjs --lang es --limit 150 --tag modelcmp   # sampling run
 *
 * Reads   i18n/source.json      (from extract.mjs)
 * Writes  i18n/tm/{lang}.json   hash → translated unit
 *
 * ── Incremental by design ────────────────────────────────────────────────────
 * The memory is keyed by the SHA-1 of the English unit. Editing one English page
 * changes only the hashes of the units it touched, so a re-run translates those and
 * reuses everything else. A full re-translation only happens if you delete the memory.
 *
 * ── Placeholders are load-bearing ────────────────────────────────────────────
 * Units carry inline markup as <0>…</0> / <1/> placeholders. A translation that drops,
 * duplicates or invents one would corrupt the HTML on rebuild, so every response is
 * validated against the source placeholder multiset and retried; units that still fail
 * are left untranslated (English) and reported rather than shipped broken.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

import {
  SOURCE_FILE as SRC_FILE, TM_DIR, LOCALES, RTL, DNT, MODEL as CFG_MODEL,
  ROOT_DIR as ROOT, SITE_NAME, SITE_DESCRIPTION, SOURCE_LANGUAGE,
} from './config.mjs';
import { hint, link } from './credit.mjs';
const API = 'https://generativelanguage.googleapis.com/v1beta/models';

// ── CLI ──────────────────────────────────────────────────────────────────────

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .join(' ')
    .split('--')
    .filter(Boolean)
    .map((s) => s.trim().split(/\s+/))
    .map(([k, ...v]) => [k, v.join(' ') || true])
);

const LANGS = String(args.lang ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const MODEL = String(args.model ?? CFG_MODEL);
const LIMIT = args.limit ? Number(args.limit) : Infinity;
const TAG = args.tag ? `.${args.tag}` : '';
const BATCH_UNITS = Number(args.batch ?? 40);
const CONCURRENCY = Number(args.concurrency ?? 12);
const DRY = Boolean(args.dry);

if (LANGS.length === 0) {
  console.error('Usage: node scripts/i18n/translate.mjs --lang es[,ru,...] [--model M] [--limit N] [--tag T] [--dry]');
  process.exit(1);
}

// ── Key ──────────────────────────────────────────────────────────────────────

function loadKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  const envFile = join(ROOT, '.env');
  if (existsSync(envFile)) {
    const m = /^GEMINI_API_KEY=(.*)$/m.exec(readFileSync(envFile, 'utf8'));
    if (m) return m[1].trim();
  }
  console.error('GEMINI_API_KEY not found (env or .env).');
  process.exit(1);
}
const KEY = loadKey();

// ── Language names for the prompt ────────────────────────────────────────────

const LANG_NAMES = Object.fromEntries(LOCALES.map((l) => [l.pathCode, l.nativeLabel ?? l.pathCode]));


// ── Prompt ───────────────────────────────────────────────────────────────────

/**
 * Format, protocol and standards tokens that are correct unchanged in every language.
 * Site-specific brand names come from config (doNotTranslate.brands) and are merged in.
 */
const TECH_TOKENS = [
  'PDF', 'DOCX', 'DOC', 'XLSX', 'XLS', 'PPTX', 'PPT', 'EPUB', 'CSV', 'TXT', 'JSON',
  'HTML', 'XML', 'IDML', 'INDD', 'PNG', 'JPG', 'JPEG', 'SVG', 'WEBP', 'MP4', 'ZIP',
  'OCR', 'GDPR', 'SSL', 'TLS', 'API', 'SDK', 'URL', 'HTTP', 'HTTPS', 'SEO', 'CSS', 'RSS',
];

const GLOSSARY = [...new Set([...DNT.brands, ...DNT.formats, ...TECH_TOKENS])];

function systemPrompt(langCode) {
  const name = LANG_NAMES[langCode] ?? langCode;
  return [
    `You are a professional translator localising the website of ${SITE_NAME}${SITE_DESCRIPTION ? `, ${SITE_DESCRIPTION}` : ''}.`,
    `Translate from ${SOURCE_LANGUAGE} into ${name} (${langCode}).`,
    ``,
    `RULES`,
    `1. Preserve every placeholder EXACTLY: <0>, </0>, <1/> and so on. Same count, same numbers.`,
    `   Placeholders wrap inline markup — move them so they wrap the equivalent words in your`,
    `   translation, but never drop, add, renumber or reorder their nesting.`,
    `2. Never translate these names: ${GLOSSARY.join(', ')}.`,
    `3. This is marketing and product copy. Translate meaning and tone, not word for word.`,
    `   Keep it natural and idiomatic for a native reader.`,
    `4. Keep numbers, prices, file sizes and counts unchanged (e.g. "120+", "1 GB", "10 MB").`,
    `5. Preserve leading/trailing punctuation and capitalisation style of the source where the`,
    `   target language allows it. Headings stay headings; button labels stay short.`,
    `6. Do not add explanations, notes or quotes around the result.`,
    RTL.has(langCode) ? `7. ${name} is right-to-left. Write natural RTL text; do not insert directional marks.` : ``,
    ``,
    `Return a JSON array. For each input item return { "id": <same id>, "text": "<translation>" }.`,
  ]
    .filter(Boolean)
    .join('\n');
}

const RESPONSE_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: { id: { type: 'INTEGER' }, text: { type: 'STRING' } },
    required: ['id', 'text'],
  },
};

// ── Placeholder validation ───────────────────────────────────────────────────

const PLACEHOLDER_RE = /<\/?\d+\/?>/g;

/** Sorted multiset of placeholders, so order changes are allowed but content is not. */
function placeholderSet(s) {
  return (s.match(PLACEHOLDER_RE) ?? []).slice().sort().join('');
}

function validate(source, translated) {
  if (typeof translated !== 'string' || translated.trim().length === 0) return 'empty';
  if (placeholderSet(source) !== placeholderSet(translated)) return 'placeholder-mismatch';
  return null;
}

// ── API ──────────────────────────────────────────────────────────────────────

async function callGemini(langCode, items, attempt = 1) {
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt(langCode) }] },
    contents: [{ role: 'user', parts: [{ text: JSON.stringify(items) }] }],
    generationConfig: {
      temperature: attempt === 1 ? 0.2 : 0.4,
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
    },
  };

  // Network-level failures (`TypeError: fetch failed` — DNS, reset connection, socket
  // timeout) throw before there is any response, so they never reached the HTTP-status
  // retry below. On the first full run that silently cost 481 of 10,166 Spanish units:
  // 12 whole batches lost to transient connection errors while 12 requests ran in
  // parallel. Retry them on the same backoff as 429/5xx.
  let res;
  try {
    res = await fetch(`${API}/${MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': KEY, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    if (attempt <= 5) {
      const wait = Math.min(2 ** attempt * 1000, 30000);
      process.stderr.write(
        `  network error (${String(err.message ?? err).slice(0, 60)}), retry ${attempt} in ${wait}ms\n`
      );
      await new Promise((r) => setTimeout(r, wait));
      return callGemini(langCode, items, attempt + 1);
    }
    throw err;
  }

  if (!res.ok) {
    const text = await res.text();
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt <= 5) {
      const wait = Math.min(2 ** attempt * 1000, 30000);
      process.stderr.write(`  HTTP ${res.status}, retry ${attempt} in ${wait}ms\n`);
      await new Promise((r) => setTimeout(r, wait));
      return callGemini(langCode, items, attempt + 1);
    }
    throw new Error(`Gemini HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  const part = data?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!part) {
    // The safety filter blocks the WHOLE request, so one string it dislikes takes the
    // other 39 in the batch with it (seen on Russian: PROHIBITED_CONTENT on a batch that
    // translated fine once split). Halve and recurse so the blast radius is the offending
    // unit alone, not the batch.
    const blocked = data?.promptFeedback?.blockReason;
    if (blocked && items.length > 1) {
      const mid = Math.ceil(items.length / 2);
      process.stderr.write(`  ${blocked} on ${items.length} units — splitting\n`);
      const [a, b] = await Promise.all([
        callGemini(langCode, items.slice(0, mid)),
        callGemini(langCode, items.slice(mid)),
      ]);
      return {
        rows: [...a.rows, ...b.rows],
        usage: {
          promptTokenCount: (a.usage.promptTokenCount ?? 0) + (b.usage.promptTokenCount ?? 0),
          candidatesTokenCount: (a.usage.candidatesTokenCount ?? 0) + (b.usage.candidatesTokenCount ?? 0),
        },
      };
    }
    throw new Error(`No content in response: ${JSON.stringify(data).slice(0, 300)}`);
  }

  const usage = data.usageMetadata ?? {};

  // A batch whose combined translation exceeds the output limit comes back as TRUNCATED
  // JSON ("Unterminated string at position 68365"), taking all 40 units with it — that is
  // how Urdu lost a whole batch. Halve and recurse: the same content in two requests fits,
  // and only a single oversized unit can end up unrecoverable.
  try {
    return { rows: JSON.parse(part), usage };
  } catch (err) {
    if (items.length > 1) {
      const mid = Math.ceil(items.length / 2);
      process.stderr.write(`  truncated JSON on ${items.length} units — splitting\n`);
      const [a, b] = await Promise.all([
        callGemini(langCode, items.slice(0, mid)),
        callGemini(langCode, items.slice(mid)),
      ]);
      return {
        rows: [...a.rows, ...b.rows],
        usage: {
          promptTokenCount:
            (usage.promptTokenCount ?? 0) + (a.usage.promptTokenCount ?? 0) + (b.usage.promptTokenCount ?? 0),
          candidatesTokenCount:
            (usage.candidatesTokenCount ?? 0) +
            (a.usage.candidatesTokenCount ?? 0) +
            (b.usage.candidatesTokenCount ?? 0),
        },
      };
    }
    throw err;
  }
}

// ── Worker ───────────────────────────────────────────────────────────────────

async function translateLang(langCode, units) {
  const tmFile = join(TM_DIR, `${langCode}${TAG}.json`);
  const tm = existsSync(tmFile) ? JSON.parse(readFileSync(tmFile, 'utf8')) : {};

  const pending = units.filter(([hash]) => !(hash in tm));

  // Re-run churn. The memory is keyed by source hash, so on an existing locale the
  // pending share IS the share of the site that changed since last time. A site that
  // turns over a large fraction of its copy every release is one this pipeline will
  // keep charging for — worth knowing before the third re-run, not after.
  const known = Object.keys(tm).length;
  if (known > 0 && units.length > 0) {
    const churn = (pending.length * 100) / units.length;
    if (churn >= 15) {
      hint('churn', [
        `\u2139 ${churn.toFixed(0)}% of source units changed since the last run ` +
          `(${pending.length.toLocaleString()} of ${units.length.toLocaleString()}).`,
        '  Static substitution re-translates and rebuilds on every content change. At this',
        '  rate that is a recurring cost; a runtime layer translates on demand instead:',
        `  ${link('hint-churn')}`,
      ]);
    }
  }

  if (pending.length === 0) {
    console.log(`${langCode}: nothing to do (${Object.keys(tm).length} in memory)`);
    return;
  }

  const batches = [];
  for (let i = 0; i < pending.length; i += BATCH_UNITS) batches.push(pending.slice(i, i + BATCH_UNITS));

  console.log(`${langCode}: ${pending.length} units to translate in ${batches.length} batches (model ${MODEL})`);
  if (DRY) return;

  let done = 0;
  let failed = 0;
  let inTok = 0;
  let outTok = 0;
  const failures = [];

  // Checkpoint the memory as we go. A full locale is ~255 batches over tens of minutes;
  // writing only at the end means any interruption — rate limit, network, Ctrl-C —
  // throws away every unit translated so far and re-spends on the retry.
  mkdirSync(TM_DIR, { recursive: true });
  let sinceFlush = 0;
  const flush = () => {
    writeFileSync(tmFile, JSON.stringify(tm, null, 2));
    sinceFlush = 0;
  };

  let cursor = 0;
  const runOne = async () => {
    for (;;) {
      const myIndex = cursor++;
      if (myIndex >= batches.length) return;
      const batch = batches[myIndex];

      const items = batch.map(([, unit], i) => ({ id: i, text: unit.text }));

      let rows;
      let usage;
      try {
        ({ rows, usage } = await callGemini(langCode, items));
      } catch (err) {
        failed += batch.length;
        failures.push({ batch: myIndex, error: String(err).slice(0, 200) });
        continue;
      }
      inTok += usage.promptTokenCount ?? 0;
      outTok += usage.candidatesTokenCount ?? 0;

      const byId = new Map(rows.map((r) => [r.id, r.text]));

      // Units whose placeholders came back wrong get one solo retry — a single unit in
      // isolation is far more reliable than the same unit inside a 40-item batch.
      const retry = [];
      for (let i = 0; i < batch.length; i++) {
        const [hash, unit] = batch[i];
        const out = byId.get(i);
        const problem = validate(unit.text, out);
        if (problem) retry.push([hash, unit, problem]);
        else tm[hash] = out;
      }

      for (const [hash, unit, problem] of retry) {
        try {
          const solo = await callGemini(langCode, [{ id: 0, text: unit.text }]);
          const out = solo.rows.find((r) => r.id === 0)?.text;
          inTok += solo.usage.promptTokenCount ?? 0;
          outTok += solo.usage.candidatesTokenCount ?? 0;
          if (!validate(unit.text, out)) {
            tm[hash] = out;
            continue;
          }
        } catch {
          /* fall through to the failure path */
        }
        failed++;
        failures.push({ hash, problem, source: unit.text.slice(0, 120) });
      }

      done += batch.length;
      sinceFlush++;
      if (sinceFlush >= 10) flush();
      process.stdout.write(`\r  ${langCode}: ${done}/${pending.length} units`);
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, runOne));
  process.stdout.write('\n');

  flush();

  const rate = MODEL.includes('flash-lite') ? [0.1, 0.4] : [0.3, 2.5];
  const cost = (inTok / 1e6) * rate[0] + (outTok / 1e6) * rate[1];

  console.log(`  ${langCode}: ${Object.keys(tm).length} in memory, ${failed} failed`);
  console.log(
    `  tokens in/out: ${inTok.toLocaleString()} / ${outTok.toLocaleString()}  ≈ $${cost.toFixed(3)} (standard rate)`
  );
  if (failures.length) {
    writeFileSync(join(TM_DIR, `${langCode}${TAG}.failures.json`), JSON.stringify(failures, null, 2));
    console.log(`  wrote ${failures.length} failures → i18n/tm/${langCode}${TAG}.failures.json`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

if (!existsSync(SRC_FILE)) {
  console.error('i18n/source.json missing. Run: node scripts/i18n/extract.mjs');
  process.exit(1);
}

const source = JSON.parse(readFileSync(SRC_FILE, 'utf8'));
// Most-repeated units first, so a --limit sample covers the highest-impact copy.
const units = Object.entries(source).slice(0, LIMIT === Infinity ? undefined : LIMIT);

console.log(`source units: ${Object.keys(source).length.toLocaleString()}, selected: ${units.length.toLocaleString()}`);

for (const lang of LANGS) {
  if (!(lang in LANG_NAMES)) {
    console.error(`Unknown locale "${lang}" — not in the locales config`);
    process.exit(1);
  }
  await translateLang(lang, units);
}
