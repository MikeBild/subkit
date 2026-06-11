// "Did you mean" support for the top-level dispatcher.
//
// A typo like `sk conectors list` previously fell through to the main
// command, which treated "conectors" as a REPL *prompt* and mounted the
// TUI — actively misleading. The dispatcher now asks this module for a
// close command name first and fails fast with a suggestion instead.

/** Classic dynamic-programming Levenshtein distance. Inputs are short
 *  command names, so the O(n·m) matrix is trivially cheap. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        (curr[j - 1] as number) + 1,
        (prev[j] as number) + 1,
        (prev[j - 1] as number) + cost,
      );
    }
    prev = curr;
  }
  return prev[b.length] as number;
}

/**
 * Return the closest known command for a mistyped token, or null when
 * nothing is plausibly close (distance > 2) — in which case the caller
 * keeps the current behavior (the token is treated as a REPL prompt).
 */
export function suggestCommand(input: string, commands: readonly string[]): string | null {
  const needle = input.toLowerCase();
  let best: { name: string; distance: number } | null = null;
  for (const name of commands) {
    const d = levenshtein(needle, name.toLowerCase());
    if (best === null || d < best.distance) best = { name, distance: d };
  }
  // distance 0 with a different spelling means a case-variant typo
  // ("Doctor") — still worth suggesting. An exact match returns null;
  // the dispatcher already handled those before asking.
  return best !== null && best.distance <= 2 && best.name !== input ? best.name : null;
}
