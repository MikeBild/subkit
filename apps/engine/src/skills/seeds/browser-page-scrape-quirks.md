---
slug: browser-page-scrape-quirks
scope: global
title: Browser Page Scrape Quirks
description: When to use /chrome/function vs /chrome/content, polling for late-rendered sections, structured error returns, and result validation before downstream sends.
activates_when: [{"kind":"connector_template","slug":"browserless"},{"kind":"intent_keyword","word":"scrape"},{"kind":"intent_keyword","word":"chrome"}]
side_effects: read
idempotency: none
maturity: stable
tags: [scraping, browserless, headless-chrome, reliability]
version: 2
---

# Browser Page Scrape Quirks

Headless-Chrome scrape workflows fail non-deterministically when the
author uses the wrong endpoint or does not wait for all content sections
to render. This skill captures the recurring failure modes and the
known-good patterns.

## Endpoint selection: /chrome/function vs /chrome/content

Use **/chrome/function** for any page that loads rows or data via
client-side JS after the initial HTML document arrives. This includes:
SPAs, server-side-rendered search pages that fetch results via XHR, and
any page where the row count varies by timing.

Use **/chrome/content** only for fully static pages where every row is
present in the initial HTML response. If you are not certain the page is
static, default to /chrome/function.

Why this matters: `/chrome/content` captures whatever has rendered at the
moment the browser fires the `load` event. For a page that fetches data
via XHR after load, this is the empty HTML shell — zero rows. The author
gets a silent empty result, not an error.

The page-function you POST to `/chrome/function` runs **inside the
external browserless service** — page.goto, page.waitForSelector,
page.waitForTimeout, and all Puppeteer page APIs work exactly as
documented. They are not silently swallowed by subkit.

**The `code` MUST be an ES-module default export** — `export default
async function ({ page, context }) { … }`. NOT CommonJS: `module.exports`,
`require()`, and `import` statements all make browserless reject the
request with HTTP 400 `{ "error": "module is not defined" }` even though
the call reached the service. Pass runtime inputs (URL, selectors, filter
values) through the POST body's **`context`** field and read them as the
second destructured argument — do **not** string-interpolate them into
the code or capture them from an outer closure (the function runs in a
fresh module scope where those names are undefined).

## Reliable scrape pattern

```javascript
// page-function body (runs inside browserless). Inputs arrive via `context`,
// supplied in the POST body: { "code": "…", "context": { "url": "…", "rowSelector": ".row" } }
export default async function ({ page, context }) {
  const { url, rowSelector } = context;
  await page.goto(url, { waitUntil: 'networkidle2' });

  // Wait for the primary content selector.
  try {
    await page.waitForSelector(rowSelector, { timeout: 15000 });
  } catch (_) {
    return {
      data: { error: 'selector_missing', selector: rowSelector, url: page.url() },
      type: 'application/json',
    };
  }

  let rows = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    rows = await page.evaluate((sel) =>
      Array.from(document.querySelectorAll(sel)).map((r) => ({
        text: r.textContent.trim(),
      })), rowSelector);
    if (rows.length > 0) break;
    // Section present in DOM but empty — reload and retry.
    if (attempt < 2) await page.reload({ waitUntil: 'networkidle2' });
  }

  if (rows.length === 0) {
    return {
      data: { error: 'no_rows_after_retries', selector: rowSelector, url: page.url() },
      type: 'application/json',
    };
  }

  return { data: rows, type: 'application/json' };
}
```

The three-reload poll is the known-good fix for pages that render
multiple sections (e.g. outbound and return results) at different times.
Without it the scrape non-deterministically returns 1, 8, or 14 rows
depending on which section had finished rendering when `waitForSelector`
fired.

## Structured errors from the page-function

Never return an empty array when the expected selector is absent. Return
a structured error object:

```json
{ "error": "selector_missing", "selector": ".row", "url": "https://example.com/results" }
```

The workflow step can then branch on `scope.<step>.data.error` and
either retry (via a loop) or alert the operator. An empty array silently
passes through to the downstream send step, producing an empty digest
that looks like a success.

## Verifying row count before a send step

Add an explicit guard in the JS transform that follows the scrape:

```javascript
// transform expression
const result = input.scope.scrape.data;
if (result && result.error) {
  throw new Error('Scrape failed: ' + result.error + ' (selector: ' + result.selector + ')');
}
const rows = Array.isArray(result) ? result : [];
if (rows.length === 0) {
  throw new Error('Scrape returned 0 rows — verify the selector and re-run');
}
return { rows, count: rows.length };
```

A thrown error in a JS transform step marks the step as failed and
stops the workflow before the send step fires.

## Time-format normalisation

Some pages abbreviate hour-only times as `"9:"` instead of `"09:00"`.
Normalise in the transform before building the digest body:

```javascript
const fixed = text.replace(/\b(\d):/g, '0$1:');
```

This regex matches a single digit followed by a colon at a word
boundary — it turns `"9:"` into `"09:"` without touching `"09:30"` or
ISO timestamps.

## Common pitfalls

- **Capture too early yields partial results.** If `page.waitForSelector`
  resolves on a section header but the rows beneath it are still loading,
  `page.evaluate` returns an empty array. Poll with reload until rows > 0.
- **Two-section pages need two checks.** Waiting for section A does not
  guarantee section B is populated. After the first `waitForSelector`,
  verify both sections have rows before returning.
- **Silent empty digest.** Returning `[]` from the page-function when no
  rows were found lets the workflow proceed normally. The send step fires
  and sends an empty email. Add the row-count guard in the transform.
- **page.waitForSelector and page.waitForTimeout run inside browserless.**
  If they appear to have no effect the selector is wrong, not the
  infrastructure. Probe /chrome/function with a minimal page-function to
  inspect `document.querySelectorAll(selector).length` before authoring
  the full workflow.

## See also

- `browserless-basics` (template-skills) — endpoint reference, auth, unblock, proxy.
- `workflow-authoring.md` — dry-runs; `workflow-authoring-repair.md` — the transform-requires-inspect gate.
- `data-handling.md` — JS transform contract (one `input` global, explicit `return`).
