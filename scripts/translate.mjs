#!/usr/bin/env node
/**
 * i18n step 2 — translate extracted units into a translation memory.
 *
 *   node scripts/i18n/translate.mjs --lang es
 *   node scripts/i18n/translate.mjs --lang es,ru --provider gemini --model gemini-2.5-flash-lite
 *   node scripts/i18n/translate.mjs --lang es --provider openai   # local model via apiBaseUrl
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
  SOURCE_FILE as SRC_FILE, TM_DIR, LOCALES, RTL, DNT, GLOSSARY, MODEL as CFG_MODEL,
  ROOT_DIR as ROOT, SITE_NAME, SITE_DESCRIPTION, SOURCE_LANGUAGE,
  PROVIDER as CFG_PROVIDER, API_BASE_URL, API_KEY_ENV, JSON_MODE, PRICING,
} from './config.mjs';
import { termsForBatch, glossaryPrompt, glossaryFingerprint, containsTerm } from './glossary.mjs';
import { hint, link } from './credit.mjs';
import { loadProvider, extractJson } from './providers/index.mjs';

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
const PROVIDER_NAME = args.provider ? String(args.provider) : CFG_PROVIDER;
const MODEL_ARG = args.model ? String(args.model) : CFG_MODEL;
const LIMIT = args.limit ? Number(args.limit) : Infinity;
const TAG = args.tag ? `.${args.tag}` : '';
const BATCH_UNITS = Number(args.batch ?? 40);
const CONCURRENCY = Number(args.concurrency ?? 12);
const DRY = Boolean(args.dry);

if (LANGS.length === 0) {
  console.error(
    'Usage: node scripts/i18n/translate.mjs --lang es[,ru,...] [--provider P] [--model M] [--limit N] [--tag T] [--dry]'
  );
  process.exit(1);
}

// ── Key ──────────────────────────────────────────────────────────────────────

const PROVIDER = await loadProvider({ provider: PROVIDER_NAME, model: MODEL_ARG, root: ROOT });
const MODEL = MODEL_ARG ?? PROVIDER.defaultModel;

/**
 * The key, from the environment or a .env file, under whichever variable the resolved
 * provider uses — or `apiKeyEnv` if the config names a different one. Providers that
 * set `keyOptional` (the OpenAI-compatible adapter, because local servers do not
 * authenticate) are allowed to proceed without one.
 */
function loadKey() {
  const names = API_KEY_ENV ? [API_KEY_ENV] : (PROVIDER.envKeys ?? []);
  for (const name of names) if (process.env[name]) return process.env[name];

  const envFile = join(ROOT, '.env');
  if (existsSync(envFile)) {
    const text = readFileSync(envFile, 'utf8');
    for (const name of names) {
      const m = new RegExp(`^${name}=(.*)$`, 'm').exec(text);
      if (m) return m[1].trim();
    }
  }

  if (PROVIDER.keyOptional) return null;
  console.error(
    `No API key for ${PROVIDER.label ?? PROVIDER.id}. Set ${names.join(' or ')} in the ` +
      `environment or .env, or set "apiKeyEnv" in i18n.config.json.`
  );
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

/**
 * The flat never-translate list that still goes into rule 2. The structured glossary
 * (config.GLOSSARY) carries the same brands plus per-locale targets and is injected
 * per batch; this line stays because format and protocol tokens are correct unchanged
 * in every language and are cheap to state once.
 */
const DNT_NAMES = [...new Set([...DNT.brands, ...DNT.formats, ...TECH_TOKENS])];

function systemPrompt(langCode, batchTerms = []) {
  const name = LANG_NAMES[langCode] ?? langCode;
  const terminology = glossaryPrompt(batchTerms, langCode);
  return [
    `You are a professional translator localising the website of ${SITE_NAME}${SITE_DESCRIPTION ? `, ${SITE_DESCRIPTION}` : ''}.`,
    `Translate from ${SOURCE_LANGUAGE} into ${name} (${langCode}).`,
    ``,
    `RULES`,
    `1. Preserve every placeholder EXACTLY: <0>, </0>, <1/> and so on. Same count, same numbers.`,
    `   Placeholders wrap inline markup — move them so they wrap the equivalent words in your`,
    `   translation, but never drop, add, renumber or reorder their nesting.`,
    `2. Never translate these names: ${DNT_NAMES.join(', ')}.`,
    `   Match whole words, and respect capitalisation: a lowercase common noun that`,
    `   happens to spell a brand name is the common noun, and must be translated.`,
    `3. This is marketing and product copy. Translate meaning and tone, not word for word.`,
    `   Keep it natural and idiomatic for a native reader.`,
    `4. Keep numbers, prices, file sizes and counts unchanged (e.g. "120+", "1 GB", "10 MB").`,
    `5. Preserve leading/trailing punctuation and capitalisation style of the source where the`,
    `   target language allows it. Headings stay headings; button labels stay short.`,
    `6. Do not add explanations, notes or quotes around the result.`,
    RTL.has(langCode) ? `7. ${name} is right-to-left. Write natural RTL text; do not insert directional marks.` : ``,
    terminology,
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

/**
 * One request to whichever provider is loaded.
 *
 * The provider module owns three things and nothing else: how to build the request,
 * how to read a response, and how to price it. Everything that made this function
 * worth keeping — network-error retry, HTTP backoff, splitting a batch that was
 * refused or truncated — is provider-agnostic and lives here, unchanged from the
 * version that ran ten thousand units through Gemini.
 *
 * `usage` is normalised to { inTok, outTok } so the caller never sees a provider's
 * own field names.
 */
async function callModel(langCode, items, attempt = 1, jsonMode = JSON_MODE, drop = new Set()) {
  // Recomputed per call, not per run, so a batch that gets halved on a safety block or a
  // truncation carries exactly the terms its own half contains.
  const batchTerms = termsForBatch(GLOSSARY, items.map((i) => i.text), langCode);

  const { url, headers, body } = PROVIDER.request({
    model: MODEL,
    system: systemPrompt(langCode, batchTerms),
    items,
    temperature: attempt === 1 ? 0.2 : 0.4,
    key: KEY,
    baseUrl: API_BASE_URL,
    jsonMode,
    drop,
  });

  const split = async (why, mode = jsonMode) => {
    const mid = Math.ceil(items.length / 2);
    process.stderr.write(`  ${why} on ${items.length} units — splitting\n`);
    const [a, b] = await Promise.all([
      callModel(langCode, items.slice(0, mid), 1, mode, drop),
      callModel(langCode, items.slice(mid), 1, mode, drop),
    ]);
    return {
      rows: [...a.rows, ...b.rows],
      usage: { inTok: a.usage.inTok + b.usage.inTok, outTok: a.usage.outTok + b.usage.outTok },
    };
  };

  // Network-level failures (`TypeError: fetch failed` — DNS, reset connection, socket
  // timeout) throw before there is any response, so they never reached the HTTP-status
  // retry below. On the first full run that silently cost 481 of 10,166 Spanish units:
  // 12 whole batches lost to transient connection errors while 12 requests ran in
  // parallel. Retry them on the same backoff as 429/5xx.
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch (err) {
    if (attempt <= 5) {
      const wait = Math.min(2 ** attempt * 1000, 30000);
      process.stderr.write(
        `  network error (${String(err.message ?? err).slice(0, 60)}), retry ${attempt} in ${wait}ms\n`
      );
      await new Promise((r) => setTimeout(r, wait));
      return callModel(langCode, items, attempt + 1, jsonMode, drop);
    }
    throw err;
  }

  if (!res.ok) {
    const text = await res.text();

    // An OpenAI-compatible server that does not implement the structured-output form we
    // asked for rejects the whole request. That is a capability gap, not a broken run:
    // drop one rung of the ladder and retry. Placeholder validation still guards output.
    if (PROVIDER.unsupportedJsonMode?.(res.status, text)) {
      const next = (jsonMode ?? 'schema') === 'schema' ? 'object' : 'none';
      if ((jsonMode ?? 'schema') !== 'none') {
        process.stderr.write(
          `  server rejected JSON mode "${jsonMode ?? 'schema'}" — retrying with "${next}"\n`
        );
        return callModel(langCode, items, attempt, next, drop);
      }
    }

    // The same idea one level down: a server that rejects ONE parameter is telling us
    // about its capabilities, not about a broken run. Drop that parameter and retry.
    // `drop` only ever grows, so each parameter is dropped at most once and this cannot
    // loop. Adapters that do not implement the hook are unaffected.
    const bad = PROVIDER.unsupportedParam?.(res.status, text);
    if (bad && !drop.has(bad)) {
      process.stderr.write(`  server rejected "${bad}" — retrying without it\n`);
      return callModel(langCode, items, attempt, jsonMode, new Set(drop).add(bad));
    }

    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt <= 5) {
      const wait = Math.min(2 ** attempt * 1000, 30000);
      process.stderr.write(`  HTTP ${res.status}, retry ${attempt} in ${wait}ms\n`);
      await new Promise((r) => setTimeout(r, wait));
      return callModel(langCode, items, attempt + 1, jsonMode, drop);
    }
    throw new Error(`${PROVIDER.label ?? PROVIDER.id} HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  const { text: part, usage, retryable, detail } = PROVIDER.parse(data);

  // A safety filter rejects the WHOLE request, so one string it dislikes takes the other
  // 39 in the batch with it (seen on Russian: PROHIBITED_CONTENT on a batch that
  // translated fine once split). Halve and recurse so the blast radius is the offending
  // unit alone, not the batch.
  if (retryable === 'safety' && items.length > 1) return split(detail ?? 'safety block');

  if (!part) {
    if (retryable === 'safety') throw new Error(`Safety block on a single unit (${detail})`);
    throw new Error(`No content in response: ${JSON.stringify(data).slice(0, 300)}`);
  }

  // A batch whose combined translation exceeds the output limit comes back as TRUNCATED
  // JSON ("Unterminated string at position 68365"), taking all 40 units with it — that is
  // how Urdu lost a whole batch. Halve and recurse: the same content in two requests fits,
  // and only a single oversized unit can end up unrecoverable. Some providers say so via
  // a stop reason; the rest are caught by the parse failing.
  if (retryable === 'truncated' && items.length > 1) {
    const half = await split('output limit reached');
    return { rows: half.rows, usage: { inTok: usage.inTok + half.usage.inTok, outTok: usage.outTok + half.usage.outTok } };
  }

  try {
    const parsed = JSON.parse(extractJson(part));
    const rows = PROVIDER.unwrap ? PROVIDER.unwrap(parsed) : parsed;
    if (!Array.isArray(rows)) throw new Error('response was not an array of units');
    return { rows, usage };
  } catch (err) {
    if (items.length > 1) {
      const half = await split('truncated JSON');
      return {
        rows: half.rows,
        usage: { inTok: usage.inTok + half.usage.inTok, outTok: usage.outTok + half.usage.outTok },
      };
    }
    throw err;
  }
}

// ── Worker ───────────────────────────────────────────────────────────────────

async function translateLang(langCode, units) {
  const tmFile = join(TM_DIR, `${langCode}${TAG}.json`);
  const tm = existsSync(tmFile) ? JSON.parse(readFileSync(tmFile, 'utf8')) : {};

  // ── Glossary invalidation ──────────────────────────────────────────────────
  // The memory is keyed by the source hash alone, so editing a glossary target used to
  // change nothing: every affected unit was already in the memory and got skipped, and
  // the new terminology silently never shipped. The sidecar records the fingerprint the
  // memory was built against; when it moves, the units containing an affected term are
  // dropped so they re-translate. Only those — a term change must not cost a full locale.
  //
  // It is a SIDECAR, not a key inside the memory, because README documents
  // i18n/tm/{lang}.json as a hand-editable hash -> string map and three other scripts
  // iterate it. A `__meta` key would have made every coverage count off by one.
  const metaFile = join(TM_DIR, `${langCode}${TAG}.meta.json`);
  const meta = existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, 'utf8')) : {};
  const fingerprint = glossaryFingerprint(GLOSSARY);

  if (typeof meta.glossary === 'string' && meta.glossary !== fingerprint) {
    const before = new Set(meta.glossary.split('\n').filter(Boolean));
    const after = new Set(fingerprint.split('\n').filter(Boolean));
    // A term whose line is missing from either side has been added, removed or edited.
    const changed = GLOSSARY.filter((t) => {
      const line = glossaryFingerprint([t]);
      return !before.has(line) || !after.has(line);
    });
    // Removed terms are gone from GLOSSARY, so recover them from the old fingerprint to
    // re-translate units that were constrained by a rule the user has just deleted.
    const removedSources = [...before]
      .filter((line) => !after.has(line))
      .map((line) => line.split('|')[2])
      .filter(Boolean);

    let dropped = 0;
    for (const [hash, unit] of units) {
      if (!(hash in tm)) continue;
      const hit =
        changed.some((t) => containsTerm(unit.text, t)) ||
        removedSources.some((src) => containsTerm(unit.text, { source: src, matchCase: false }));
      if (hit) {
        delete tm[hash];
        dropped++;
      }
    }
    if (dropped) {
      process.stderr.write(
        `  glossary changed — re-translating ${dropped.toLocaleString()} affected unit(s)\n`
      );
    }
  }

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
    // Nothing pending means nothing was dropped, so the memory on disk already matches
    // this glossary — safe to record the fingerprint without a translation pass. The
    // fingerprint is never written ahead of a TM flush: if a run dies mid-way, the next
    // one must still see a stale fingerprint and re-drop the affected units.
    writeFileSync(metaFile, JSON.stringify({ ...meta, glossary: fingerprint }, null, 2));
    return;
  }

  const batches = [];
  for (let i = 0; i < pending.length; i += BATCH_UNITS) batches.push(pending.slice(i, i + BATCH_UNITS));

  console.log(`${langCode}: ${pending.length} units to translate in ${batches.length} batches`);
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
    writeFileSync(metaFile, JSON.stringify({ ...meta, glossary: fingerprint }, null, 2));
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
        ({ rows, usage } = await callModel(langCode, items));
      } catch (err) {
        failed += batch.length;
        failures.push({ batch: myIndex, error: String(err).slice(0, 200) });
        continue;
      }
      inTok += usage.inTok;
      outTok += usage.outTok;

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
          const solo = await callModel(langCode, [{ id: 0, text: unit.text }]);
          const out = solo.rows.find((r) => r.id === 0)?.text;
          inTok += solo.usage.inTok;
          outTok += solo.usage.outTok;
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

  // Token counts are always printed because they are measured. A cost is printed only
  // when a rate is actually known — from the config, or the provider's own table. A
  // hardcoded guess for somebody else's price list goes stale and misleads; the
  // OpenAI-compatible adapter deliberately reports no rate at all, because it points at
  // dozens of providers and some of them are a local model that costs nothing.
  const rate = PRICING ?? PROVIDER.pricing?.(MODEL) ?? null;

  console.log(`  ${langCode}: ${Object.keys(tm).length} in memory, ${failed} failed`);
  const tokens = `  tokens in/out: ${inTok.toLocaleString()} / ${outTok.toLocaleString()}`;
  if (rate) {
    const cost = (inTok / 1e6) * rate[0] + (outTok / 1e6) * rate[1];
    console.log(`${tokens}  ≈ $${cost.toFixed(3)} at $${rate[0]}/$${rate[1]} per Mtok`);
  } else {
    console.log(`${tokens}  (no rate known for this model — set "pricing" in i18n.config.json)`);
  }
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

console.log(
  `provider: ${PROVIDER.label ?? PROVIDER.id} · model: ${MODEL}` +
    (PROVIDER_NAME ? '' : ' (inferred — set "provider" in i18n.config.json to pin it)') +
    (API_BASE_URL ? ` · host: ${API_BASE_URL}` : '')
);
console.log(`source units: ${Object.keys(source).length.toLocaleString()}, selected: ${units.length.toLocaleString()}`);

for (const lang of LANGS) {
  if (!(lang in LANG_NAMES)) {
    console.error(`Unknown locale "${lang}" — not in the locales config`);
    process.exit(1);
  }
  await translateLang(lang, units);
}
