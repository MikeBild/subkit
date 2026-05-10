// Grapheme-aware helpers for the next-message preview render. Only
// the FIRST grapheme of a string is needed (for the inverse-cursor
// trick) — the rest of the ghost is rendered via plain `<Text dimColor>`,
// which doesn't care about graphemes.
//
// Why grapheme-aware: the ghost text we render is operator-typed
// English in 99% of cases, but slash-kind suggestions can carry skill
// args that include emoji or CJK. Slicing `text[0]` on a ZWJ-emoji
// like 👨‍🚀 prints a half-emoji. `Intl.Segmenter` is the only
// stdlib-correct way to get the actual user-perceived first character.

const segmenter =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

/**
 * Return the first user-perceived grapheme of `text`, or an empty
 * string when input is empty. Falls back to the first UTF-16 code
 * point when `Intl.Segmenter` is unavailable (Bun has it natively
 * since 1.0; the fallback is defensive only).
 */
export function firstGrapheme(text: string): string {
  if (text.length === 0) return "";
  if (segmenter) {
    const iter = segmenter.segment(text)[Symbol.iterator]();
    const next = iter.next();
    if (!next.done) return next.value.segment;
  }
  return text.charAt(0);
}
