const DEFAULT_RANK_CONSTANT = 60;

export function fuseByReciprocalRank<T>(opts: {
  lists: readonly (readonly T[])[];
  idOf: (item: T) => string;
  limit: number;
  k?: number;
}): T[] {
  const k = opts.k ?? DEFAULT_RANK_CONSTANT;
  const entries = new Map<string, { item: T; score: number; first: number }>();
  let seen = 0;
  for (const list of opts.lists) {
    const inList = new Set<string>();
    let rank = 0;
    for (const item of list) {
      const id = opts.idOf(item);
      if (inList.has(id)) continue;
      inList.add(id);
      rank += 1;
      const gain = 1 / (k + rank);
      const entry = entries.get(id);
      if (entry) {
        entry.score += gain;
      } else {
        entries.set(id, { item, score: gain, first: seen });
        seen += 1;
      }
    }
  }
  return [...entries.values()]
    .sort((a, b) => b.score - a.score || a.first - b.first)
    .slice(0, Math.max(0, opts.limit))
    .map((entry) => entry.item);
}

export function keepTopScored<T>(
  top: Array<{ item: T; score: number }>,
  candidate: { item: T; score: number },
  size: number,
): void {
  if (size <= 0) return;
  if (top.length >= size && candidate.score <= (top[top.length - 1]?.score ?? -Infinity)) return;
  let at = top.length;
  while (at > 0 && (top[at - 1]?.score ?? -Infinity) < candidate.score) at -= 1;
  top.splice(at, 0, candidate);
  if (top.length > size) top.length = size;
}
