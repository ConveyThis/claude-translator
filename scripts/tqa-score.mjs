/**
 * TQA scoring primitives — the parts with no I/O, no network and no config, so they can
 * be tested directly. tqa.mjs owns the run; this file owns the arithmetic and the
 * sampling, which are the parts a reader is entitled to check.
 */

/**
 * Severity weights. These are the conventional MQM values — minor 1, major 5,
 * critical 10 — kept rather than tuned, so a score here means the same thing it means
 * in any other MQM report.
 */
export const WEIGHT = { minor: 1, major: 5, critical: 10 };

/**
 * The typology offered to the judge. Deliberately short: a long taxonomy produces
 * category-shopping and inconsistent labelling between runs, and the categories that
 * matter for web localization are these.
 */
export const CATEGORIES = [
  'accuracy/mistranslation',
  'accuracy/omission',
  'accuracy/addition',
  'accuracy/untranslated',
  'fluency/grammar',
  'fluency/spelling',
  'fluency/register',
  'fluency/awkward',
  'terminology/inconsistent',
  'terminology/glossary',
  'locale/number-date-currency',
  'style/tone',
  'markup/placeholder',
];

// ── Deterministic sampling ───────────────────────────────────────────────────

/** mulberry32 — a small seeded PRNG, so a reported score can be reproduced exactly. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const words = (s) => (String(s).trim().match(/\S+/g) ?? []).length;

/**
 * Stratified sample, weighted by how often a unit appears on the site.
 *
 * A uniform sample over-represents the long tail of one-off strings and under-represents
 * the header, footer and nav that every visitor reads on every page. `count` is already
 * recorded by extract.mjs, so weighting by it costs nothing and makes the score reflect
 * what people actually see. Strata are frequency terciles, sampled proportionally.
 */
export function stratifiedSample(units, n, seed) {
  if (units.length <= n) return units.slice();
  const rand = rng(seed);
  const sorted = units.slice().sort((a, b) => (b.count ?? 1) - (a.count ?? 1));
  const third = Math.ceil(sorted.length / 3);
  const strata = [sorted.slice(0, third), sorted.slice(third, third * 2), sorted.slice(third * 2)];

  const picked = [];
  strata.forEach((stratum, i) => {
    if (!stratum.length) return;
    // The most-repeated third gets half the sample; the rest split the remainder.
    const share = i === 0 ? 0.5 : 0.25;
    const want = Math.min(stratum.length, Math.max(1, Math.round(n * share)));
    const pool = stratum.slice();
    for (let k = 0; k < want && pool.length; k++) {
      picked.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
    }
  });
  return picked.slice(0, n);
}


/**
 * MQM score for a set of assessed units.
 */
export function score(assessed) {
  const totalWords = assessed.reduce((n, a) => n + a.words, 0);
  let penalty = 0;
  const byCategory = {};
  const bySeverity = { minor: 0, major: 0, critical: 0 };

  for (const a of assessed) {
    for (const e of a.errors) {
      penalty += WEIGHT[e.severity];
      bySeverity[e.severity]++;
      byCategory[e.category] = (byCategory[e.category] ?? 0) + 1;
    }
  }
  const mqm = totalWords ? 100 - (penalty / totalWords) * 100 : 100;
  return {
    mqm: Math.round(mqm * 100) / 100,
    penalty,
    totalWords,
    unitsAssessed: assessed.length,
    unitsClean: assessed.filter((a) => a.errors.length === 0).length,
    bySeverity,
    byCategory,
  };
}


/** Parse the judge's per-unit payload. Anything unreadable is dropped, never guessed. */
export function parseErrors(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return null;
    return parsed
      .map((e) => ({
        category: String(e.c ?? e.category ?? '').trim(),
        severity: String(e.s ?? e.severity ?? '').trim().toLowerCase(),
        note: String(e.n ?? e.note ?? '').trim(),
      }))
      .filter((e) => WEIGHT[e.severity] !== undefined);
  } catch {
    return null;
  }
}
