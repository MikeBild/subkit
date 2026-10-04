export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  const prev = new Array<number>(bl + 1);
  const cur = new Array<number>(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;
  for (let i = 1; i <= al; i++) {
    cur[0] = i;
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    for (let j = 0; j <= bl; j++) prev[j] = cur[j]!;
  }
  return prev[bl]!;
}

export function suggestClosest(
  target: string,
  candidates: ReadonlyArray<string>,
  limit = 3,
): string[] {
  const t = target.toLowerCase();
  const threshold = Math.max(2, Math.floor(target.length / 2));
  return candidates
    .filter((c) => c !== target)
    .map((c) => ({ id: c, dist: levenshtein(c.toLowerCase(), t) }))
    .filter((s) => s.dist <= threshold)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, limit)
    .map((s) => s.id);
}

export function extractStepIdReferences(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const patterns = [
    /\$scope\.([a-zA-Z_][\w-]*)/g,
    /\$steps\.([a-zA-Z_][\w-]*)/g,
    /\$\{\s*scope\.([a-zA-Z_][\w-]*)/g,
  ];
  for (const re of patterns) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      const id = m[1] ?? "";
      if (id && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  }
  return out;
}
