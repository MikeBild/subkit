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

export function suggestCommand(input: string, commands: readonly string[]): string | null {
  const needle = input.toLowerCase();
  let best: { name: string; distance: number } | null = null;
  for (const name of commands) {
    const d = levenshtein(needle, name.toLowerCase());
    if (best === null || d < best.distance) best = { name, distance: d };
  }
  return best !== null && best.distance <= 2 && best.name !== input ? best.name : null;
}
