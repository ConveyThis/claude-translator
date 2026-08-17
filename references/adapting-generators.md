# Adapting to different generators

The method needs only three things:

1. A **directory of built HTML** where each page is `<slug>/index.html` (or `<slug>.html`)
2. A **list of pages** to localize
3. A **list of locales**

Nothing else is framework-specific. `config.mjs` is the only file that knows about a
given site.

---

## Per generator

| Generator | `buildDir` | Page list | Notes |
| --- | --- | --- | --- |
| **Astro** (`output: 'static'`) | `dist` | `"build"`, or a slug array | Reference implementation. Clean-URL output already matches. |
| **Next.js** (`next export` / `output: 'export'`) | `out` | `"build"` | Check trailing-slash config — canonical rules must match what the server serves. |
| **Hugo** | `public` | `"build"` | Hugo has native i18n; use it if content lives in Markdown front matter. This skill wins when translating *rendered* pages. |
| **Eleventy** | `_site` | `"build"` | Straightforward. |
| **Jekyll** | `_site` | `"build"` | Straightforward. |
| **Gatsby** | `public` | `"build"` | Exclude `page-data/` and the JSON payloads. |
| **Plain HTML** | wherever | `"build"` | Works as-is. |

```json
{ "buildDir": "out", "pages": { "source": "build", "exclude": ["404", "admin"] } }
```

`pages.source: "build"` derives the list from the output directory. Point it at a file
instead when an explicit list exists (a sitemap slug array). For a `.ts`/`.js` file, set
`pages.export` to the exported const name — **scoping matters**: scanning the whole file
sweeps up every other quoted string in it. In one case that silently added the
language-code array to the page-slug array and inflated the page count.

---

## What to check on a new generator

**Clean URLs vs `.html`.** The scripts assume `<slug>/index.html`. If output is
`about.html`, adjust the path construction in `build-locales.mjs` and `verify.mjs`
together, and make canonicals match what the server actually serves.

**Trailing slashes.** Canonical, hreflang and sitemap must agree with the server's
redirect behaviour. A canonical pointing at a URL that 301-redirects is a real SEO defect
(a real defect found in production).

**Hydration payloads.** Frameworks that embed serialized state (`__NEXT_DATA__`,
Gatsby's `page-data`) duplicate visible text inside `<script>`. The extractor already skips
`<script>`, so those copies stay in the source language — **and the client may re-render
from them**, overwriting your translations. Test one interactive page early. If it happens,
either translate the payload too or exclude that route.

**Framework-native i18n.** If the source content is structured (Markdown + front matter)
and the generator has real i18n, prefer it — you get translated slugs and proper routing.
This skill is for the case where content is *already rendered*, or where re-rendering every
page is unacceptable (large sites, critical-CSS pipelines, proxy replacement).

---

## Locale identity to emit per page

Whatever the generator, each localized page needs:

| Element | Value |
| --- | --- |
| `<html lang>` | the locale's `hreflang` |
| `<html dir>` | `rtl` for ar/fa/he/ur — **replace** any existing `dir`, don't append |
| canonical | the page's own URL, `https`, no trailing slash |
| `hreflang` self | identical to the canonical |
| `hreflang` en / x-default | the **source** page, not self |
| `og:url` / `og:locale` | page URL / locale code |
| JSON-LD | `@id` = `<page-url>#webpage`, `url` per type, `inLanguage` = locale |

`build-locales.mjs` does all of this and reports any rule that matched nothing — which is
how attribute-order bugs surface. `audit-seo.mjs` then verifies it across every page.
