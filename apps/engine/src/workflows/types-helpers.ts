// Internal helpers extracted from `workflows/types.ts` so that file
// stays under the 1000-LOC audit ceiling. Pure functions only — Zod
// schemas remain in `types.ts` (or in `types-web-scraper.ts` for
// the web-scraper connector).

/** RFC 7230 header-name token: pre-validate `Name:` before handing the
 *  string to `new Headers()` so JSON-shaped strings don't slip through
 *  as a single header named `'{"Accept"'`. */
export const HTTP_TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Parse a multi-line "Name: Value\nOther: Other" header string into a
 *  record, trimming whitespace on both sides. Returns `null` when no
 *  valid header line was found (so validation can fail with a useful
 *  message instead of silently coercing garbage). Empty lines are
 *  tolerated; lines without a `:` are rejected.
 *
 *  Header names are validated as RFC 7230 tokens — without this, a
 *  JSON-encoded string like `'{"Accept": "..."}'` would parse as a
 *  single header named `'{"Accept"'`, slip through validation, and
 *  blow up inside `new Headers()` at fetch time with the obtuse
 *  "Invalid header name" error (conversation 730c568a). */
export function parseHeaderLines(raw: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  let saw = 0;
  for (const lineRaw of raw.split(/\r?\n/)) {
    const line = lineRaw.trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx <= 0) return null;
    const name = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!name) return null;
    if (!HTTP_TOKEN_RE.test(name)) return null;
    out[name] = value;
    saw += 1;
  }
  return saw > 0 ? out : null;
}

/** True when the trimmed string starts/ends with matching JSON brackets
 *  and parses to an object or array. Used by the GraphQL config sniffer
 *  to disambiguate inline JSON variables from bare query strings. */
export function looksLikeJsonObjectOrArray(s: string): boolean {
  const trimmed = s.trim();
  if (trimmed.length === 0) return false;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if (!(first === "{" && last === "}") && !(first === "[" && last === "]")) return false;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed !== null && (typeof parsed === "object" || Array.isArray(parsed));
  } catch {
    return false;
  }
}
