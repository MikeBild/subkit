// Tiny Levenshtein helper. Used in two places that need a "did you
// mean" suggestion against a small candidate list:
//   - authoring-time: `validateStepReferences` flags a JSONata path
//     pointing at an unknown step id.
//   - runtime: `loop.over` / `branch.when` resolved to undefined; we
//     match the literal step id parsed out of the expression against
//     the actual scope keys.
//
// Both sites share the same suggestion contract so the LLM gets the
// same "did_you_mean" vocabulary regardless of where the typo was
// caught.

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

/**
 * Return up to `limit` candidates closest to `target` (case-insensitive).
 * A candidate only qualifies when its distance is ≤ max(2, target.length / 2)
 * — keeps the list focused on real near-misses ("custumer" → "customer")
 * instead of every short id in scope.
 */
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

/**
 * Pull step-id references out of a JSONata expression / placeholder
 * string. Recognises `$scope.<id>`, `$steps.<id>`, and `${scope.<id>`
 * placeholder forms. Returns the unique id list in source order.
 *
 * The runtime calls this when an expression resolves to undefined to
 * decide whether the failure is "no step id matched" (we surface a
 * typed `did_you_mean`) vs. "the step exists but the path under it
 * is wrong" (separate diagnosis). Bare `id.field` paths (no `$scope`
 * prefix) aren't extracted — JSONata treats those as data-context
 * lookups, not step references.
 */
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
