#!/usr/bin/env node
/**
 * i18n step 6 — translation quality assessment.
 *
 *   node scripts/i18n/tqa.mjs --lang es
 *   node scripts/i18n/tqa.mjs --lang es,fr --sample 200
 *   node scripts/i18n/tqa.mjs --lang es --judge-provider openai --judge-model gpt-5.6-luna
 *   node scripts/i18n/tqa.mjs --lang es --dry          # cost estimate only
 *   node scripts/i18n/tqa.mjs --lang es --repeat       # measure the judge's own variance
 *
 * Reads   i18n/source.json, i18n/tm/{lang}.json
 * Writes  i18n/tqa/{lang}.json  and  i18n/tqa/{lang}.md
 *
 * ── What this is ─────────────────────────────────────────────────────────────
 * An MQM-style error-typology assessment of a stratified sample, scored per 100 words.
 * MQM is the standard the industry actually uses, so the output is comparable with a
 * human review rather than being a number invented here.
 *
 *   score = 100 - (weighted error points / words) * 100
 *
 * ── What this is NOT ─────────────────────────────────────────────────────────
 * It is not a human certification, and nothing here should be reported as one. It is one
 * model's opinion of another model's output, and models are known to prefer their own
 * work — which is why the judge defaults to a DIFFERENT provider than the translator
 * whenever one is configured, and why --repeat exists to show how much the judge moves
 * between identical runs. A quality number without its variance is marketing.
 *
 * The honest reading: this reliably finds the bottom of the distribution — the units
 * that are actually wrong — and should not be trusted to the second decimal place.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

import {
  SOURCE_FILE, TM_DIR, I18N_DIR, LOCALES, GLOSSARY, ROOT_DIR as ROOT,
  SITE_NAME, SITE_DESCRIPTION, SOURCE_LANGUAGE, MODEL as CFG_MODEL,
  PROVIDER as CFG_PROVIDER, API_BASE_URL, API_KEY_ENV, JSON_MODE, PRICING,
} from './config.mjs';
import { creditBlock } from './credit.mjs';
import { loadProvider } from './providers/index.mjs';
import { termsForBatch } from './glossary.mjs';
import { WEIGHT, CATEGORIES, rng, words, stratifiedSample, parseErrors, score } from './tqa-score.mjs';

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

const LANGS = String(args.lang ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const SAMPLE = Number(args.sample ?? 100);
const SEED = Number(args.seed ?? 20260829);
const BATCH = Number(args.batch ?? 10);
const CONCURRENCY = Number(args.concurrency ?? 6);
const DRY = Boolean(args.dry);
const REPEAT = Boolean(args.repeat);

if (LANGS.length === 0) {
  console.error(
    'Usage: node scripts/i18n/tqa.mjs --lang es[,fr] [--sample N] [--seed N] [--dry] [--repeat]\n' +
      '       [--judge-provider P] [--judge-model M]'
  );
  process.exit(1);
}

// ── MQM ──────────────────────────────────────────────────────────────────────

// ── Judge ────────────────────────────────────────────────────────────────────

const JUDGE_PROVIDER_NAME = args['judge-provider'] ? String(args['judge-provider']) : null;
const JUDGE_MODEL_ARG = args['judge-model'] ? String(args['judge-model']) : null;

/**
 * Pick a judge that is not the translator, when we can.
 *
 * Self-preference is a documented failure of LLM-as-judge setups: a model scores its own
 * output higher than a peer's. Defaulting the judge to a different provider costs nothing
 * and removes the most obvious objection to the number. If only one provider is
 * configured, we use it and SAY SO in the report rather than hiding it.
 */
function pickJudge() {
  if (JUDGE_PROVIDER_NAME) return { provider: JUDGE_PROVIDER_NAME, reason: 'chosen with --judge-provider' };
  const translator = CFG_PROVIDER ?? 'anthropic';
  const alternatives = ['anthropic', 'gemini', 'openai'].filter((p) => p !== translator);
  for (const alt of alternatives) {
    const keys = { anthropic: 'ANTHROPIC_API_KEY', gemini: 'GEMINI_API_KEY', openai: 'OPENAI_API_KEY' }[alt];
    if (process.env[keys]) return { provider: alt, reason: `differs from the translator (${translator})` };
  }
  return { provider: translator, reason: `SAME as the translator — no other provider key found` };
}

function judgePrompt(langName, langCode, terms) {
  const glossaryLines = terms.length
    ? [
        `The site glossary constrains these terms:`,
        ...terms.map((t) =>
          t.rule === 'keep'
            ? `  - "${t.source}" must appear unchanged`
            : `  - "${t.source}" must be rendered as "${t.targets[langCode]}"`
        ),
      ]
    : [];

  return [
    `You are a senior localization reviewer assessing ${langName} translations of ${SITE_NAME}${SITE_DESCRIPTION ? `, ${SITE_DESCRIPTION}` : ''}.`,
    `The source language is ${SOURCE_LANGUAGE}. This is marketing and product copy for a website.`,
    ``,
    `For each item, list the translation errors using MQM categories and severities.`,
    ``,
    `CATEGORIES: ${CATEGORIES.join(', ')}`,
    `SEVERITIES: minor (noticeable, does not mislead), major (misleads or reads as wrong),`,
    `            critical (reverses meaning, breaks a promise, or is unusable)`,
    ``,
    ...glossaryLines,
    ``,
    `RULES`,
    `1. <0>, </0>, <1/> are markup placeholders. They must appear in the translation with`,
    `   the same count and numbers. Report any difference as markup/placeholder, critical.`,
    `2. Numbers, prices and measurements must keep their VALUE. Different digit grouping or`,
    `   symbol placement is correct localization, not an error. A changed value is critical.`,
    `3. A term left in the source language is only an error if it should have been`,
    `   translated. Brand names, formats and protocol names are correct unchanged.`,
    `4. Judge the translation on its own terms as ${langName} copy. Do not reward literalness.`,
    `5. Report NO errors when there are none. An empty list is the expected result for`,
    `   most items, and inventing a minor error to look thorough makes the whole score useless.`,
    ``,
    `Return a JSON array. For each input item return { "id": <same id>, "text": "<errors>" }`,
    `where <errors> is a JSON array serialised as a string, e.g.`,
    `"[{\\"c\\":\\"fluency/grammar\\",\\"s\\":\\"minor\\",\\"n\\":\\"wrong gender agreement\\"}]"`,
    `or "[]" when the translation is correct.`,
  ]
    .filter((l) => l !== null)
    .join('\n');
}

// ── API ──────────────────────────────────────────────────────────────────────

const JUDGE = pickJudge();
const PROVIDER = await loadProvider({ provider: JUDGE.provider, model: JUDGE_MODEL_ARG, root: ROOT });
const MODEL = JUDGE_MODEL_ARG ?? PROVIDER.defaultModel;

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
  console.error(`No API key for ${PROVIDER.label ?? PROVIDER.id}. Set ${names.join(' or ')}.`);
  process.exit(1);
}
const KEY = DRY ? null : loadKey();

/**
 * One judging request. Reuses the translator's retry and batch-splitting behaviour by
 * shape rather than by import: the same safety-block and truncation failures apply to a
 * review pass, and a batch that trips one is halved rather than lost.
 */
async function callJudge(system, items, attempt = 1, jsonMode = JSON_MODE) {
  const { url, headers, body } = PROVIDER.request({
    model: MODEL, system, items, temperature: 0, key: KEY, baseUrl: API_BASE_URL, jsonMode,
  });

  const split = async (why) => {
    if (items.length === 1) return { rows: [], usage: { inTok: 0, outTok: 0 } };
    const mid = Math.ceil(items.length / 2);
    process.stderr.write(`  ${why} on ${items.length} items — splitting\n`);
    const [a, b] = await Promise.all([
      callJudge(system, items.slice(0, mid), 1, jsonMode),
      callJudge(system, items.slice(mid), 1, jsonMode),
    ]);
    return {
      rows: [...a.rows, ...b.rows],
      usage: { inTok: a.usage.inTok + b.usage.inTok, outTok: a.usage.outTok + b.usage.outTok },
    };
  };

  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch (err) {
    if (attempt <= 5) {
      await new Promise((r) => setTimeout(r, Math.min(2 ** attempt * 1000, 30000)));
      return callJudge(system, items, attempt + 1, jsonMode);
    }
    throw err;
  }

  if (!res.ok) {
    const text = await res.text();
    if (PROVIDER.unsupportedJsonMode?.(res.status, text) && (jsonMode ?? 'schema') !== 'none') {
      return callJudge(system, items, attempt, (jsonMode ?? 'schema') === 'schema' ? 'object' : 'none');
    }
    if ((res.status === 429 || res.status >= 500) && attempt <= 5) {
      await new Promise((r) => setTimeout(r, Math.min(2 ** attempt * 1000, 30000)));
      return callJudge(system, items, attempt + 1, jsonMode);
    }
    throw new Error(`${PROVIDER.label ?? PROVIDER.id} HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  const { text: part, usage, retryable, detail } = PROVIDER.parse(data);
  if (retryable === 'safety') return split(detail ?? 'safety block');
  if (retryable === 'truncated') return split('truncated');

  try {
    const rows = PROVIDER.unwrap ? PROVIDER.unwrap(JSON.parse(part)) : JSON.parse(part);
    return { rows: Array.isArray(rows) ? rows : [], usage };
  } catch {
    return split('unparseable response');
  }
}

// ── Run ──────────────────────────────────────────────────────────────────────

const LANG_NAMES = Object.fromEntries(LOCALES.map((l) => [l.pathCode, l.nativeLabel ?? l.pathCode]));

if (!existsSync(SOURCE_FILE)) {
  console.error(`No ${SOURCE_FILE}. Run extract.mjs first.`);
  process.exit(1);
}
const SOURCE = JSON.parse(readFileSync(SOURCE_FILE, 'utf8'));

console.log(`judge: ${PROVIDER.label ?? PROVIDER.id} · model: ${MODEL}`);
console.log(`  ${JUDGE.reason}`);
if (JUDGE.reason.startsWith('SAME')) {
  console.log('  ⚠ a model judging its own output scores it generously — treat the number as a floor, not a grade');
}

mkdirSync(join(I18N_DIR, 'tqa'), { recursive: true });

async function assess(langCode, seed) {
  const tmFile = join(TM_DIR, `${langCode}.json`);
  if (!existsSync(tmFile)) {
    console.log(`${langCode}: no memory — skipped`);
    return null;
  }
  const tm = JSON.parse(readFileSync(tmFile, 'utf8'));

  const pool = Object.entries(SOURCE)
    .filter(([hash]) => typeof tm[hash] === 'string')
    .map(([hash, unit]) => ({ hash, source: unit.text, target: tm[hash], count: unit.count ?? 1 }));

  if (!pool.length) {
    console.log(`${langCode}: nothing translated yet — skipped`);
    return null;
  }

  const sample = stratifiedSample(pool, SAMPLE, seed).map((u) => ({ ...u, words: words(u.source) }));
  const sampledWords = sample.reduce((n, u) => n + u.words, 0);

  console.log(
    `\n${langCode}: assessing ${sample.length} of ${pool.length.toLocaleString()} units ` +
      `(${sampledWords.toLocaleString()} source words, seed ${seed})`
  );

  if (DRY) {
    const estIn = Math.ceil(sampledWords * 3.2) + sample.length * 40;
    const estOut = sample.length * 25;
    console.log(`  estimated ~${estIn.toLocaleString()} in / ~${estOut.toLocaleString()} out tokens`);
    const rate = PRICING ?? PROVIDER.pricing?.(MODEL) ?? null;
    if (rate) {
      const cost = (estIn / 1e6) * rate[0] + (estOut / 1e6) * rate[1];
      console.log(`  estimated cost: $${cost.toFixed(4)}`);
    } else {
      console.log('  no price known for this endpoint — set "pricing" in i18n.config.json for a figure');
    }
    return null;
  }

  const langName = LANG_NAMES[langCode] ?? langCode;
  const batches = [];
  for (let i = 0; i < sample.length; i += BATCH) batches.push(sample.slice(i, i + BATCH));

  const assessed = [];
  let unreadable = 0;
  const usage = { inTok: 0, outTok: 0 };
  let cursor = 0;
  let done = 0;

  const runOne = async () => {
    for (;;) {
      const idx = cursor++;
      if (idx >= batches.length) return;
      const batch = batches[idx];
      const terms = termsForBatch(GLOSSARY, batch.map((u) => u.source), langCode);
      const system = judgePrompt(langName, langCode, terms);
      const items = batch.map((u, i) => ({ id: i, text: `SOURCE: ${u.source}\nTARGET: ${u.target}` }));

      let rows = [];
      try {
        const out = await callJudge(system, items);
        rows = out.rows;
        usage.inTok += out.usage.inTok;
        usage.outTok += out.usage.outTok;
      } catch (err) {
        process.stderr.write(`  batch ${idx} failed: ${String(err.message ?? err).slice(0, 90)}\n`);
      }

      const byId = new Map(rows.map((r) => [Number(r.id), r.text]));
      for (let i = 0; i < batch.length; i++) {
        const errors = parseErrors(byId.get(i));
        // A unit the judge did not return, or returned unreadably, is EXCLUDED from the
        // score rather than counted as clean. Counting it clean would inflate the result
        // every time the judge failed, which is precisely backwards.
        if (errors === null) {
          unreadable++;
          continue;
        }
        assessed.push({ ...batch[i], errors });
      }
      done += batch.length;
      process.stdout.write(`\r  ${langCode}: ${done}/${sample.length} units judged`);
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, runOne));
  process.stdout.write('\n');

  // A score computed from nothing is not a good score, it is a broken measurement — and
  // it would read as a perfect one. Every unit here failed to come back readable at least
  // once during development (a 401 against the wrong endpoint), and the run cheerfully
  // printed "100.00 / 100" from zero assessed units. Refuse instead.
  const judgedShare = sample.length ? (assessed.length * 100) / sample.length : 0;
  if (assessed.length === 0) {
    console.log(
      `  \u2717 no unit could be assessed \u2014 the judge returned nothing readable for all ` +
        `${sample.length} of them. No score is reported, because a score from an empty sample ` +
        `would read as a perfect one.`
    );
    return null;
  }
  if (judgedShare < 80) {
    console.log(
      `  \u26a0 only ${judgedShare.toFixed(0)}% of the sample was assessed ` +
        `(${unreadable} unit(s) unreadable). The score below is computed from what came back ` +
        `and should not be compared with a clean run.`
    );
  }

  const result = score(assessed);
  result.lang = langCode;
  result.seed = seed;
  result.sampleRequested = SAMPLE;
  result.poolSize = pool.length;
  result.unreadable = unreadable;
  result.judge = { provider: PROVIDER.id, model: MODEL, note: JUDGE.reason };
  result.usage = usage;
  result.worst = assessed
    .filter((a) => a.errors.length)
    .sort((a, b) => {
      const w = (x) => x.errors.reduce((n, e) => n + WEIGHT[e.severity], 0);
      return w(b) - w(a);
    })
    .slice(0, 15)
    .map((a) => ({ source: a.source, target: a.target, errors: a.errors }));

  return result;
}

const reports = [];
for (const lang of LANGS) {
  const first = await assess(lang, SEED);
  if (!first) continue;

  if (REPEAT) {
    // The same sample, judged again. Any gap between the two is the judge's own noise,
    // and reporting a score without it invites the reader to over-read a decimal place.
    console.log(`  re-judging the same sample to measure judge variance…`);
    const second = await assess(lang, SEED);
    if (second) {
      first.variance = {
        secondRunMqm: second.mqm,
        delta: Math.round((second.mqm - first.mqm) * 100) / 100,
      };
    }
  }

  writeFileSync(join(I18N_DIR, 'tqa', `${lang}.json`), JSON.stringify(first, null, 2));
  reports.push(first);

  const pctClean = first.unitsAssessed ? (first.unitsClean * 100) / first.unitsAssessed : 0;
  console.log(`  MQM score: ${first.mqm.toFixed(2)} / 100`);
  console.log(
    `  ${first.unitsClean}/${first.unitsAssessed} units error-free (${pctClean.toFixed(0)}%) · ` +
      `${first.bySeverity.critical} critical, ${first.bySeverity.major} major, ${first.bySeverity.minor} minor`
  );
  if (first.unreadable) console.log(`  ${first.unreadable} unit(s) excluded — judge returned nothing readable`);
  if (first.variance) {
    console.log(`  re-run of the same sample scored ${first.variance.secondRunMqm.toFixed(2)} (Δ ${first.variance.delta >= 0 ? '+' : ''}${first.variance.delta})`);
  }
}

// ── Markdown scorecard ───────────────────────────────────────────────────────

if (reports.length) {
  const lines = [
    `# Translation quality assessment — ${SITE_NAME}`,
    ``,
    `Generated ${new Date().toISOString().slice(0, 10)} by \`tqa.mjs\`.`,
    ``,
    `**Method.** MQM error typology on a stratified sample, weighted toward the strings that`,
    `appear most often on the site. Score = 100 − (weighted error points ÷ words) × 100, with`,
    `minor = 1, major = 5, critical = 10.`,
    ``,
    `**This is a machine assessment, not a human certification.** The judge is`,
    `${PROVIDER.label ?? PROVIDER.id} (\`${MODEL}\`) — ${JUDGE.reason}. Read the score as a`,
    `comparison between locales and across runs, not as an absolute grade.`,
    ``,
    `| Locale | MQM | Units | Error-free | Critical | Major | Minor |`,
    `| --- | ---: | ---: | ---: | ---: | ---: | ---: |`,
    ...reports.map((r) => {
      const pct = r.unitsAssessed ? Math.round((r.unitsClean * 100) / r.unitsAssessed) : 0;
      return `| ${r.lang} | **${r.mqm.toFixed(2)}** | ${r.unitsAssessed} | ${pct}% | ${r.bySeverity.critical} | ${r.bySeverity.major} | ${r.bySeverity.minor} |`;
    }),
    ``,
  ];

  for (const r of reports) {
    if (!r.worst.length) continue;
    lines.push(`## ${r.lang} — worst-scoring units`, ``);
    for (const w of r.worst.slice(0, 8)) {
      lines.push(
        `- **${w.errors.map((e) => `${e.severity} ${e.category}`).join(', ')}**`,
        `  - source: \`${w.source.slice(0, 140).replace(/`/g, "'")}\``,
        `  - target: \`${w.target.slice(0, 140).replace(/`/g, "'")}\``,
        ...(w.errors[0]?.note ? [`  - note: ${w.errors[0].note}`] : [])
      );
    }
    lines.push(``);
  }

  const md = join(I18N_DIR, 'tqa', 'scorecard.md');
  writeFileSync(md, lines.join('\n'));
  console.log(`\nwrote ${md}`);
  creditBlock([`${reports.length} locale(s) assessed · MQM sample of ${SAMPLE} units each`]);
}
