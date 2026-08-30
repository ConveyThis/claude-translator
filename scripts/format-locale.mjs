/**
 * Locale conventions — number, percent and currency FORMATTING.
 *
 * ── What this does and, more importantly, does not do ────────────────────────
 * It changes how a quantity is WRITTEN. It never changes what the quantity IS.
 *
 *   1,234.56  ->  1.234,56   (de)      formatting     yes
 *   $5        ->  5 $        (fr)      formatting     yes
 *   $5        ->  4,60 €     (fr)      conversion     NEVER
 *
 * Currency conversion is deliberately absent and will stay absent. A price is a
 * commercial commitment; converting one silently, at a rate that goes stale the day it
 * is written, turns a translation tool into a source of mispriced offers. What the
 * pipeline does instead is REPORT every page where a monetary amount appears, so the
 * site owner can decide per market. That report is i18n/locale-format.json.
 *
 * Unit conversion (in->cm, F->C) is likewise not implemented. The config key is reserved
 * so a config written today does not break when it lands.
 *
 * ── Why this is deterministic and not a prompt rule ──────────────────────────
 * translate.mjs rule 4 tells the model to leave numbers ALONE, and that stays. Models
 * are unreliable at separator conventions and there is no way to verify a per-locale
 * separator choice cheaply. Intl is exact, free, and already in Node. So the model
 * preserves the number and this module re-writes its presentation afterwards, at splice
 * time, where the result can be diffed against the source.
 *
 * ── Why the matching is narrow ───────────────────────────────────────────────
 * Pulling numbers out of prose with a regex is the dangerous part of this file. A
 * greedy pattern will happily "fix" a version number, a time, an IP address or a phone
 * number into nonsense. So a run only touches a number when it is unambiguously a
 * quantity: attached to a currency symbol or code, followed by a percent sign, or
 * written with digit-grouping separators. Everything else is left exactly as it is,
 * which is the correct default for anything this module cannot positively identify.
 */

/**
 * Currency symbols and ISO codes worth recognising. Symbol first (longest first, so "CA$"
 * beats "$"), then codes. Anything not listed is simply not treated as currency, which
 * means it is left alone — the safe direction.
 */
const CURRENCY_SYMBOLS = [
  ['CA$', 'CAD'], ['A$', 'AUD'], ['NZ$', 'NZD'], ['HK$', 'HKD'], ['R$', 'BRL'],
  ['US$', 'USD'], ['$', 'USD'], ['€', 'EUR'], ['£', 'GBP'], ['¥', 'JPY'],
  ['₹', 'INR'], ['₽', 'RUB'], ['₩', 'KRW'], ['₺', 'TRY'], ['₴', 'UAH'],
  ['zł', 'PLN'], ['Kč', 'CZK'], ['R', 'ZAR'],
];

/** Characters that may appear inside a written number: digits, separators, thin spaces. */
const SEP = '.,    ';

/**
 * Contexts in which a run of digits is NOT a quantity we may reformat.
 *
 * Every entry here is a real false positive that a naive pattern produces:
 *   1.2.3      semantic version        "Node 20.5.1"
 *   10:30      time                    "opens at 10:30"
 *   192.168.1.1 IPv4
 *   2026-08-29 ISO date
 *   +1-800-555 phone number
 *   1/2        fraction or date part
 *   v2.0       version with a prefix
 */
const UNSAFE_NEIGHBOUR_BEFORE = /[:\-\/\d]$/;
const UNSAFE_NEIGHBOUR_AFTER = /^[:\-\/\d]/;

/**
 * The full extent of a numeric run: digits plus any separator that could be part of the
 * same written number. Matching the WHOLE run matters even when we decide not to touch
 * it, because the scanner must then skip past all of it — re-entering the middle of
 * "192.168.1.1" is precisely how it once produced "1.921.681,1".
 */
const NUM_RUN = /^\d+(?:[.,\u00a0\u202f ]\d+)*/;

/**
 * Is this run a well-formed written number, and if so what is its value?
 *
 * Accepts exactly three shapes, and nothing else:
 *   1234            plain integer
 *   1,234,567       grouped — ONE consistent separator, groups of exactly 3
 *   1,234.56        grouped with a decimal part, using the OTHER separator
 *   1234.56         plain decimal
 *
 * Rejecting everything else is what protects version numbers ("1.2.3" — a group of one
 * digit), IP addresses ("192.168.1.1" — same), and dotted identifiers. A rejected run is
 * emitted verbatim.
 */
function parseWritten(raw) {
  if (/^\d+$/.test(raw)) {
    const value = Number(raw);
    return Number.isFinite(value) ? { value, decimals: 0, grouped: false } : null;
  }

  const GROUPED = /^(\d{1,3})((?:[.,\u00a0\u202f ]\d{3})+)(?:([.,])(\d+))?$/;
  const m = GROUPED.exec(raw);
  if (m) {
    const [, head, groups, decSep, decDigits] = m;
    const seps = new Set([...groups.matchAll(/[.,\u00a0\u202f ]/g)].map((x) => x[0]));
    // "1,234.567,89" mixes separators — not a number anyone wrote on purpose.
    if (seps.size !== 1) return null;
    const groupSep = [...seps][0];
    // The decimal mark must differ from the group mark, or "1.234.567" is ambiguous.
    if (decSep && decSep === groupSep) return null;
    const digits = head + groups.replace(/[.,\u00a0\u202f ]/g, '');
    const value = Number(decDigits ? `${digits}.${decDigits}` : digits);
    return Number.isFinite(value) ? { value, decimals: decDigits?.length ?? 0, grouped: true } : null;
  }

  // Plain decimal: one separator, 1-3 digits after it. Two decimal places is money;
  // three would be a group, which the branch above already handled.
  const DECIMAL = /^(\d+)([.,])(\d{1,3})$/;
  const d = DECIMAL.exec(raw);
  if (d) {
    const value = Number(`${d[1]}.${d[3]}`);
    return Number.isFinite(value) ? { value, decimals: d[3].length, grouped: false } : null;
  }

  return null;
}

/**
 * Format one amount for a locale, holding the currency constant.
 * Returns null if Intl refuses the locale or currency, so the caller leaves the text alone.
 */
function formatCurrency(value, decimals, currency, locale) {
  try {
    // When the source wrote decimals, keep exactly that many — "$1,234.5" must not gain a
    // digit it did not have. When it wrote none, defer to Intl, which knows that USD
    // shows two and JPY shows none. Forcing 0 produced "1.500 $" for "1,500 USD".
    const opts = decimals > 0
      ? { style: 'currency', currency, minimumFractionDigits: decimals, maximumFractionDigits: decimals }
      : { style: 'currency', currency };
    return new Intl.NumberFormat(locale, opts).format(value);
  } catch {
    return null;
  }
}

function formatNumber(value, decimals, locale) {
  try {
    return new Intl.NumberFormat(locale, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(value);
  } catch {
    return null;
  }
}

function formatPercent(value, decimals, locale) {
  try {
    // Intl's percent style multiplies by 100, so divide first to keep the printed value.
    return new Intl.NumberFormat(locale, {
      style: 'percent',
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(value / 100);
  } catch {
    return null;
  }
}

/**
 * Rewrite the locale conventions in one translated string.
 *
 * @returns { text, changes, money } — `money` is the amounts seen, for the review report.
 */
export function formatText(text, locale, options = {}) {
  const opts = {
    numbers: true,
    percent: true,
    currency: 'format',
    ...options,
  };
  if (typeof text !== 'string' || !text) return { text, changes: [], money: [] };

  const changes = [];
  const money = [];
  let out = '';
  let i = 0;

  const symbols = CURRENCY_SYMBOLS.slice().sort((a, b) => b[0].length - a[0].length);

  while (i < text.length) {
    // A placeholder is markup, never prose. Skip it whole so no pattern can reach inside.
    const ph = /^<\/?\d+\/?>/.exec(text.slice(i));
    if (ph) {
      out += ph[0];
      i += ph[0].length;
      continue;
    }

    let matched = false;

    // ── Currency: symbol before the number ("$1,234.50", "€10") ──────────────
    if (opts.currency === 'format') {
      for (const [sym, code] of symbols) {
        if (!text.startsWith(sym, i)) continue;
        const rest = text.slice(i + sym.length);
        const run = NUM_RUN.exec(rest.replace(/^[\u00a0\u202f ]/, ''));
        if (!run) continue;
        const lead = rest.length - rest.replace(/^[\u00a0\u202f ]/, '').length;
        const raw = run[0];
        const after = rest.slice(lead + raw.length);
        // A dotted or dashed continuation means this was never a price.
        if (UNSAFE_NEIGHBOUR_AFTER.test(after)) break;
        const parsed = parseWritten(raw);
        if (!parsed) break;

        const formatted = formatCurrency(parsed.value, parsed.decimals, code, locale);
        const original = sym + rest.slice(0, lead) + raw;
        money.push({ currency: code, value: parsed.value, wrote: formatted ?? original });
        if (formatted && formatted !== original) {
          changes.push({ from: original, to: formatted, kind: 'currency' });
          out += formatted;
        } else {
          out += original;
        }
        i += sym.length + lead + raw.length;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    // ── A numeric run, possibly followed by % or a currency code ─────────────
    const runMatch = NUM_RUN.exec(text.slice(i));
    if (runMatch) {
      const raw = runMatch[0];
      const before = out.slice(-1);
      const rest = text.slice(i + raw.length);

      const unsafe = UNSAFE_NEIGHBOUR_BEFORE.test(before) || UNSAFE_NEIGHBOUR_AFTER.test(rest);
      const pct = /^[\u00a0\u202f ]?%/.exec(rest);
      const codeAfter = /^[\u00a0\u202f ]?([A-Z]{3})\b/.exec(rest);
      const knownCode = codeAfter && symbols.some(([, c]) => c === codeAfter[1]);
      const parsed = unsafe ? null : parseWritten(raw);

      if (parsed) {
        if (pct && opts.percent) {
          const formatted = formatPercent(parsed.value, parsed.decimals, locale);
          if (formatted && formatted !== raw + pct[0]) {
            changes.push({ from: raw + pct[0], to: formatted, kind: 'percent' });
            out += formatted;
            i += raw.length + pct[0].length;
            continue;
          }
        } else if (knownCode && opts.currency === 'format') {
          const formatted = formatCurrency(parsed.value, parsed.decimals, codeAfter[1], locale);
          const original = raw + codeAfter[0];
          money.push({ currency: codeAfter[1], value: parsed.value, wrote: formatted ?? original });
          if (formatted && formatted !== original) {
            changes.push({ from: original, to: formatted, kind: 'currency' });
            out += formatted;
            i += raw.length + codeAfter[0].length;
            continue;
          }
        } else if (opts.numbers && parsed.grouped) {
          // Only grouped numbers. A bare "2026" or "50" has no separator convention to
          // get wrong, and rewriting it risks mangling a year or a count.
          const formatted = formatNumber(parsed.value, parsed.decimals, locale);
          if (formatted && formatted !== raw) {
            changes.push({ from: raw, to: formatted, kind: 'number' });
            out += formatted;
            i += raw.length;
            continue;
          }
        }
      }

      // Emit the WHOLE run untouched and step past all of it. Advancing by less would
      // let the scanner re-enter the middle of something it just declined to format.
      out += raw;
      i += raw.length;
      continue;
    }

    out += text[i];
    i += 1;
  }

  return { text: out, changes, money };
}

/**
 * The BCP-47 tag to hand Intl for a locale row. `hreflang` is already the right shape
 * ("pt-BR", "zh-Hant"); pathCode is a URL segment ("pt-br") and is not.
 */
export function intlLocale(row) {
  return row?.hreflang ?? row?.pathCode ?? 'en';
}
