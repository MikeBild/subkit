const PROTECTED_SOURCE = [
  "https?:\\/\\/[^\\s<>\"'\\u201E\\u201C\\u201D\\u201A\\u2018\\u2019\\u00BB\\u00AB]+",
  "[\\p{L}\\p{N}._%+-]+@[\\p{L}\\p{N}-]+(?:\\.[\\p{L}\\p{N}-]+)+",
  "(?<![\\p{L}\\p{N}])[@#][\\p{L}\\p{N}_][\\p{L}\\p{N}_.-]*",
  "(?<![\\p{L}\\p{N}_-])(?=[\\p{L}\\p{N}_-]*\\p{N})(?=[\\p{L}\\p{N}_-]*[\\p{L}_-])[\\p{L}\\p{N}][\\p{L}\\p{N}_-]*",
].join("|");

const TRAILING_PUNCTUATION = /[.,;:!?)\]}]+$/u;
const QUOTE_MARKS =
  /["'`\u00AB\u00BB\u2018\u2019\u201A\u201B\u201C\u201D\u201E\u201F\u2039\u203A]/gu;
const DASHES = /[‐‑‒–—―−]/gu;
const WORD_CHAR = /[\p{L}\p{N}]/u;

export const MIN_QUOTE_CHARS = 6;
export const MIN_QUOTE_WORDS = 2;
export const MAX_QUOTE_CHARS = 400;

function foldPlain(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/\u00DF/g, "ss")
    .replace(QUOTE_MARKS, '"')
    .replace(DASHES, "-")
    .toLowerCase();
}

function splitProtected(token: string): { kept: string; rest: string } {
  const trailing = TRAILING_PUNCTUATION.exec(token);
  if (!trailing) return { kept: token, rest: "" };
  return { kept: token.slice(0, trailing.index), rest: trailing[0] };
}

export function protectedTokens(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(new RegExp(PROTECTED_SOURCE, "gu"))) {
    const { kept } = splitProtected(match[0]);
    if (kept.length > 0) out.push(kept);
  }
  return out;
}

export function normalizeForQuote(text: string): string {
  let out = "";
  let cursor = 0;
  for (const match of text.matchAll(new RegExp(PROTECTED_SOURCE, "gu"))) {
    const start = match.index ?? 0;
    const { kept, rest } = splitProtected(match[0]);
    out += foldPlain(text.slice(cursor, start));
    out += kept;
    out += foldPlain(rest);
    cursor = start + match[0].length;
  }
  out += foldPlain(text.slice(cursor));
  return out.replace(/\s+/gu, " ").trim();
}

function boundedAt(haystack: string, start: number, length: number): boolean {
  const before = start > 0 ? haystack.charAt(start - 1) : "";
  const after = haystack.charAt(start + length);
  const first = haystack.charAt(start);
  const last = haystack.charAt(start + length - 1);
  if (before && WORD_CHAR.test(before) && WORD_CHAR.test(first)) return false;
  if (after && WORD_CHAR.test(after) && WORD_CHAR.test(last)) return false;
  return true;
}

export function occursBounded(needle: string, haystack: string): boolean {
  if (needle.length === 0) return false;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return false;
    if (boundedAt(haystack, at, needle.length)) return true;
    from = at + 1;
  }
}

export function wordCount(normalized: string): number {
  return normalized.split(" ").filter((part) => WORD_CHAR.test(part)).length;
}

export type QuoteCheck =
  | { ok: true; normalized: string }
  | { ok: false; reason: "quote_too_short" | "quote_too_long" | "quote_not_in_user_words" };

export function checkQuote(quote: string, userText: string): QuoteCheck {
  const normalized = normalizeForQuote(quote);
  if (normalized.length > MAX_QUOTE_CHARS) return { ok: false, reason: "quote_too_long" };
  if (normalized.length < MIN_QUOTE_CHARS || wordCount(normalized) < MIN_QUOTE_WORDS) {
    return { ok: false, reason: "quote_too_short" };
  }
  return occursBounded(normalized, normalizeForQuote(userText))
    ? { ok: true, normalized }
    : { ok: false, reason: "quote_not_in_user_words" };
}
