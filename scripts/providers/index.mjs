/**
 * Provider resolution.
 *
 * Three built-ins, plus any local file: set `provider` to a path ending in `.mjs` and
 * it is imported as-is. The interface is four exports — see references/providers.md.
 *
 * ── Why inference exists ─────────────────────────────────────────────────────
 * 1.2 changed the default provider from Gemini to Claude. Configs written against 1.0
 * and 1.1 pin `"model": "gemini-2.5-flash-lite"` and have no `provider` key, so a bare
 * default would send a Gemini model id to Anthropic and fail with something unhelpful
 * about an unknown model. Inferring the provider from the model id keeps every existing
 * config working untouched; only a config with NEITHER key gets the new default.
 */

import { pathToFileURL } from 'url';
import { resolve } from 'path';

import * as gemini from './gemini.mjs';
import * as anthropic from './anthropic.mjs';
import * as openai from './openai.mjs';

export const BUILTIN = { gemini, anthropic, openai };

/** The provider used when a config names neither a provider nor a model. */
export const DEFAULT_PROVIDER = 'anthropic';

/** model id → provider, for configs that predate the `provider` key. */
const INFERENCE = [
  [/^gemini[-.]/i, 'gemini'],
  [/^(models\/)?gemini/i, 'gemini'],
  [/^claude[-.]/i, 'anthropic'],
  [/^(gpt|o[1-9]|chatgpt|text-davinci)/i, 'openai'],
];

export function inferProvider(model) {
  if (!model) return null;
  for (const [re, id] of INFERENCE) if (re.test(model)) return id;
  return null;
}

const isPath = (name) => name.endsWith('.mjs') || name.includes('/');

/**
 * Resolve a provider module from an explicit name, or infer one from the model.
 * Returns the module; the caller supplies the model and key.
 */
export async function loadProvider({ provider, model, root }) {
  const name = provider ?? inferProvider(model) ?? DEFAULT_PROVIDER;

  if (isPath(name)) {
    const abs = resolve(root ?? process.cwd(), name);
    let mod;
    try {
      mod = await import(pathToFileURL(abs).href);
    } catch (err) {
      console.error(`Could not load custom provider "${name}" (${abs}):\n  ${err.message}`);
      process.exit(1);
    }
    for (const fn of ['request', 'parse']) {
      if (typeof mod[fn] !== 'function') {
        console.error(`Custom provider "${name}" does not export ${fn}(). See references/providers.md.`);
        process.exit(1);
      }
    }
    return mod;
  }

  const mod = BUILTIN[name];
  if (!mod) {
    console.error(
      `Unknown provider "${name}". Built-ins: ${Object.keys(BUILTIN).join(', ')}.\n` +
        `For anything else, point "provider" at a .mjs file — see references/providers.md.`
    );
    process.exit(1);
  }
  return mod;
}

/**
 * Strip a markdown code fence before parsing. Hosted models with a schema never need
 * this; local and smaller models wrap JSON in ```json fences constantly, and that one
 * habit accounts for most of the "it just fails on Ollama" reports.
 */
export function extractJson(text) {
  const t = String(text).trim();
  const fenced = /^```(?:json|JSON)?\s*\n([\s\S]*?)\n?```$/.exec(t);
  if (fenced) return fenced[1].trim();
  // Some models prepend a sentence before the JSON. Fall back to the outermost bracket.
  if (!t.startsWith('{') && !t.startsWith('[')) {
    const first = t.search(/[[{]/);
    const last = Math.max(t.lastIndexOf(']'), t.lastIndexOf('}'));
    if (first !== -1 && last > first) return t.slice(first, last + 1);
  }
  return t;
}
