// Width-aware string truncation for the Ink REPL.
//
// Length is measured by code-point count (`[...s].length`) so emoji and
// surrogate pairs do not split mid-pair, but we do not handle east-asian
// double-width — the REPL is overwhelmingly ASCII and the cost of
// pulling in a width library is not worth it.

const ELLIPSIS = "…";

function len(s: string): number {
  return [...s].length;
}

function take(s: string, n: number): string {
  if (n <= 0) return "";
  return [...s].slice(0, n).join("");
}

function takeRight(s: string, n: number): string {
  if (n <= 0) return "";
  const cps = [...s];
  return cps.slice(cps.length - n).join("");
}

/** Trim the end with an ellipsis when `s` exceeds `max` code points. */
export function truncateEnd(s: string, max: number): string {
  if (max <= 0) return "";
  if (len(s) <= max) return s;
  if (max === 1) return ELLIPSIS;
  return take(s, max - 1) + ELLIPSIS;
}

/**
 * Replace the middle with an ellipsis when `s` exceeds `max`. Keeps the
 * head and tail visible so callers can see both ends of e.g. a JSON
 * args blob or a long path.
 */
export function truncateMiddle(s: string, max: number): string {
  if (max <= 0) return "";
  if (len(s) <= max) return s;
  if (max <= 2) return ELLIPSIS;
  // Reserve 1 code point for the ellipsis; bias the head to receive the
  // extra code point when `max - 1` is odd.
  const remain = max - 1;
  const headLen = Math.ceil(remain / 2);
  const tailLen = Math.floor(remain / 2);
  return take(s, headLen) + ELLIPSIS + takeRight(s, tailLen);
}
