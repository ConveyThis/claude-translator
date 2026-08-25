# Providers

The translation step is the only part of this pipeline that talks to a model, and it
talks through a small adapter. Three ship with the project; anything else is one file.

---

## Choosing one

```json
{
  "provider": "anthropic",
  "model": "claude-haiku-4-5"
}
```

| `provider` | Default model | Key | Notes |
| --- | --- | --- | --- |
| `anthropic` | `claude-haiku-4-5` | `ANTHROPIC_API_KEY` | The default. |
| `gemini` | `gemini-2.5-flash-lite` | `GEMINI_API_KEY` or `GOOGLE_API_KEY` | Roughly a tenth the cost — see [throughput-and-cost.md](throughput-and-cost.md). |
| `openai` | `gpt-5.6-luna` | `OPENAI_API_KEY` | Any OpenAI-compatible endpoint, including local ones. |
| `./my-provider.mjs` | — | yours | A path is imported directly. See below. |

`--provider` and `--model` on the command line override the config for one run.

**If you omit `provider`, it is inferred from the model id** — `gemini-*` → `gemini`,
`claude-*` → `anthropic`, `gpt-*` → `openai`. This is what keeps configs written for
1.0 and 1.1 working after the 1.2 default changed to Claude. Omit both and you get
`claude-haiku-4-5`. The run prints which provider it resolved and whether it guessed.

---

## Running on a local model

The `openai` adapter speaks `/v1/chat/completions`, which Ollama, LM Studio and vLLM
all implement. Point it at one and the whole pipeline runs on your own hardware for
nothing:

```json
{
  "provider": "openai",
  "apiBaseUrl": "http://localhost:11434/v1",
  "model": "qwen2.5:14b"
}
```

No key is needed — the adapter omits the `Authorization` header when there isn't one.

> `apiBaseUrl` is the **model** host. It is deliberately a different key from `baseUrl`,
> which is your **site's** canonical origin. Confusing them would point your canonical
> tags at a language model.

Two things to expect from smaller local models. They emit JSON wrapped in a
` ```json ` fence, which the parser strips. And they often do not implement
`response_format`; when a server rejects it, the adapter drops to the next rung —
`json_schema` → `json_object` → prompt only — and says so. Placeholder validation runs
regardless, so a weaker guarantee costs retries rather than correctness. Force a rung
with `"jsonMode": "object"` if you already know what your server supports.

The same adapter covers OpenAI, Azure OpenAI, Groq, DeepSeek, Mistral, OpenRouter,
Together and Fireworks. Set `apiBaseUrl` and `model`; some need `apiKeyEnv` to point at
a differently-named variable.

---

## Which Claude model

`claude-haiku-4-5` is the default because bulk segment translation is a high-volume,
low-reasoning task and Haiku is the tier priced for it. Moving up is one line:

| Model | $/Mtok in/out | Relative cost |
| --- | --- | --- |
| `claude-haiku-4-5` | 1 / 5 | baseline |
| `claude-sonnet-5` | 3 / 15 | ~3x |
| `claude-opus-5` | 5 / 25 | ~5x |

Rates checked 2026-08-25. The larger models are better on idiom and register, which
matters for marketing copy and much less for UI strings.

One implementation detail worth knowing: the models that support adaptive thinking have
it **on by default**, and a translation run has no use for it. The adapter pins
`output_config.effort: "low"` on those tiers so you are not billed for reasoning you did
not ask for. Haiku takes no effort parameter at all — the API rejects it — so it is sent
nothing.

---

## Writing your own

A provider is a module with two required exports.

```js
// my-provider.mjs
export const id = 'my-provider';
export const label = 'My Provider';          // shown in logs and errors
export const defaultModel = 'my-model-v1';
export const envKeys = ['MY_PROVIDER_KEY'];  // checked in order, env then .env
export const keyOptional = false;            // true for local servers

/** Build one HTTP request. */
export function request({ model, system, items, temperature, key, baseUrl, jsonMode, drop }) {
  return {
    url: `${baseUrl ?? 'https://api.example.com/v1'}/translate`,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: { model, system, items, temperature },
  };
}

/** Read one response. */
export function parse(data) {
  return {
    text: data.output,                              // the raw JSON string, or null
    usage: { inTok: data.in ?? 0, outTok: data.out ?? 0 },
    retryable: null,                                // 'safety' | 'truncated' | null
    detail: data.reason,                            // shown when splitting
  };
}

/** Optional: the units are nested in your response envelope. */
export const unwrap = (parsed) => parsed.translations ?? parsed;

/** Optional: USD per million tokens, [in, out]. Omit if unknown. */
export function pricing(model) { return [0.5, 1.5]; }

/**
 * Optional: name ONE request parameter the server rejected, so translate.mjs can retry
 * without it. Return null for anything else. The parameter is added to a `drop` set
 * that is passed back into request(), and each one is dropped at most once.
 *
 * Set the bar high. The error must read as a capability complaint AND name a parameter
 * you actually send; otherwise a genuine 400 gets mistaken for a recoverable one and the
 * run quietly strips its own request instead of telling the user what is wrong.
 */
export function unsupportedParam(status, errText) {
  if (status !== 400) return null;
  return /unsupported.*\btemperature\b/i.test(errText) ? 'temperature' : null;
}
```

Then:

```json
{ "provider": "./scripts/my-provider.mjs", "model": "my-model-v1" }
```

`request` returns what to send; `parse` says what came back. Everything else —
exponential backoff, retrying network errors, halving a batch that was refused or
truncated, validating that placeholders survived, checkpointing the memory — is handled
by `translate.mjs` and applies to your adapter automatically.

**`retryable` is the important field.** Return `'safety'` when the provider refused the
whole request because of one string in it, and `'truncated'` when the output hit a
length limit. Both cause the batch to be halved and retried, which is what turns a lost
batch of forty units into one unusable unit. Return `null` and a failure takes all forty
with it.

Run `node --test scripts/providers/providers.test.mjs` — the contract tests there are
the clearest specification of what an adapter must do.

---

## Switching providers mid-project

The translation memory is keyed by a hash of the **source** text, not by model. So
changing provider translates only what is missing and reuses everything already there.
That makes a cheap first pass and a selective re-run practical: delete the units you
want redone from `i18n/tm/{lang}.json` and translate again on a better model.

The flip side is that one locale can end up part-translated by two models, with a
visible seam in voice. If that matters, delete the whole memory for that locale rather
than topping it up.
