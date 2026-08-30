/**
 * Element context — telling the translator WHAT a string is, not just what it says.
 *
 * The prompt has always ended rule 5 with "Headings stay headings; button labels stay
 * short." That sentence was unenforceable: the model received `{ id, text }` and had no
 * way to tell a <button> from a paragraph. Every string looked like prose.
 *
 * extract.mjs already knows the answer — it walks the DOM and has `node.tagName` in hand
 * at the moment it records a unit. It simply threw it away. This module turns that tag
 * into a short label the model can act on.
 *
 * ── Why a separate field, not a richer `kind` ────────────────────────────────
 * build-locales.mjs switches on `seg.kind === 'block' | 'jsonld' | startsWith('attr:')`
 * to decide how to escape a replacement. A value like 'block:button' would fall through
 * to escHtml and print literal &lt;0&gt; placeholder tokens as visible text on every
 * localized page — silent corruption that no test catches. So `kind` is untouched and
 * `el` is new.
 *
 * ── Why this costs nothing ───────────────────────────────────────────────────
 * Ordinary prose returns null and the field is omitted from the payload entirely. Only
 * the strings where the answer changes the translation carry it.
 */

/**
 * Block-level elements whose register genuinely differs from body copy.
 *
 * <a> is the interesting entry. It is an INLINE element in extract.mjs, so a link inside
 * a sentence is absorbed into the surrounding block as a <0>…</0> placeholder and never
 * recorded on its own. An <a> that DOES surface as its own unit is therefore a standalone
 * link — a call to action or a nav item — which makes it a high-precision signal rather
 * than noise.
 */
const BLOCK_ROLES = {
  button: 'button',
  a: 'button',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  title: 'page title',
  label: 'form label',
  legend: 'form label',
  summary: 'expander label',
  th: 'table header',
  figcaption: 'caption',
  option: 'menu option',
  optgroup: 'menu option',
};

/** Attribute-sourced strings. The attribute name IS the role. */
const ATTR_ROLES = {
  'attr:alt': 'image alt text',
  'attr:placeholder': 'input placeholder',
  'attr:aria-label': 'accessible label',
  'attr:aria-description': 'accessible description',
  'attr:title': 'tooltip',
};

/**
 * Meta tags carry their key in `el` as `meta:<key>`, because `kind` flattens every one of
 * them to `attr:content` and a description behaves nothing like an og:title.
 */
const META_ROLES = {
  description: 'meta description',
  'og:description': 'social share description',
  'twitter:description': 'social share description',
  'og:title': 'social share title',
  'twitter:title': 'social share title',
  'og:site_name': 'site name',
  'og:image:alt': 'image alt text',
  'twitter:image:alt': 'image alt text',
};

/**
 * The label for one unit, or null when it is ordinary prose.
 *
 * @param {{kind?: string, el?: string|null}} unit  a record from i18n/source.json
 */
export function roleOf(unit) {
  if (!unit || typeof unit !== 'object') return null;
  const { kind, el } = unit;

  // A conflicting element cleared the hint at extraction time. Saying nothing is correct
  // here — a confident wrong answer is worse than no answer.
  if (el === null || el === undefined) {
    return kind === 'jsonld' ? 'structured data' : null;
  }

  if (typeof el === 'string' && el.startsWith('meta:')) {
    return META_ROLES[el.slice(5)] ?? 'page metadata';
  }

  if (typeof kind === 'string' && kind.startsWith('attr:')) {
    return ATTR_ROLES[kind] ?? null;
  }

  if (kind === 'jsonld') return 'structured data';

  return BLOCK_ROLES[el] ?? null;
}

/**
 * The guidance block appended to the system prompt, listing only the roles actually
 * present in this batch. Empty string when the batch is all prose, so a run that
 * translates nothing but paragraphs pays not a single extra token.
 */
export function rolePrompt(roles) {
  const present = [...new Set(roles.filter(Boolean))].sort();
  if (!present.length) return '';

  const ADVICE = {
    button: 'A control the user clicks. Keep it at or near the source length — it sits in a fixed-width box. Use whatever construction your language uses on buttons, which is often not the imperative: an infinitive, a verbal noun, or a bare noun may all read better than a literal command. No final period.',
    'form label': 'Names a field. Short, nominal, no final period.',
    'expander label': 'A short clickable summary. Keep it terse.',
    heading: 'A headline. Keep it headline-shaped and roughly the source length; do not expand it into a sentence.',
    'page title': 'The browser tab and search-result title. Under about 60 characters if the language allows.',
    'meta description': 'Search-result copy. One or two sentences, under about 155 characters, written to be read in a results page.',
    'social share title': 'A share-card headline. Short and concrete.',
    'social share description': 'A share-card summary. One sentence.',
    'image alt text': 'Describes an image for someone who cannot see it. Plain and factual, no "image of".',
    'input placeholder': 'Example text inside an empty field. Very short.',
    'accessible label': 'Read aloud by a screen reader. Say what the control does.',
    'accessible description': 'Extra screen-reader detail. One short phrase.',
    tooltip: 'A hover hint. One short phrase.',
    'table header': 'A column heading. Very short, nominal.',
    caption: 'A figure caption. One short sentence.',
    'menu option': 'One choice in a dropdown. Very short.',
    'site name': 'The name of the site. Usually left unchanged.',
    'page metadata': 'Metadata, not body copy. Keep it compact.',
    'structured data': 'A search-engine structured-data value. Plain text, no markup, no added punctuation.',
  };

  return [
    `CONTEXT`,
    `Some items carry an "el" field naming what the string is on the page. It is not part`,
    `of the text and must not be translated or echoed. Where it appears, honour it:`,
    ...present.map((r) => `   - ${r}: ${ADVICE[r] ?? 'Keep the register appropriate to this element.'}`),
    `Items with no "el" field are body copy — translate them normally.`,
  ].join('\n');
}
