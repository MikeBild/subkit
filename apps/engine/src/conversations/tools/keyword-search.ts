// Tiny keyword-overlap scorer for the `find_*` family. Mirrors the
// reference impl's `keywordFilterTools` shape: split the query into
// keywords, count how many appear in each candidate's searchable
// text, return matches sorted by score (descending).
//
// Pure data — no embeddings, no LLM. The point is to give the LLM a
// keyword fuzzy lookup it can trust over `list_*` for catalogs of
// 50+ entries. For semantic search, search_knowledge / search_docs
// remain the right tools.

export interface ScoredMatch<T> {
  item: T;
  score: number;
}

export function keywordSearch<T>(
  query: string,
  items: ReadonlyArray<T>,
  toSearchableText: (item: T) => string,
  options?: { fallbackOnNoMatch?: boolean },
): T[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed || trimmed === "*" || trimmed === "all") return [...items];
  const keywords = trimmed.split(/\s+/).filter((k) => k.length > 0);
  if (keywords.length === 0) return [...items];
  const scored: ScoredMatch<T>[] = items.map((item) => {
    const text = toSearchableText(item).toLowerCase();
    const score = keywords.filter((k) => text.includes(k)).length;
    return { item, score };
  });
  const matches = scored.filter((s) => s.score > 0);
  if (matches.length === 0) {
    return options?.fallbackOnNoMatch === false ? [] : [...items];
  }
  matches.sort((a, b) => b.score - a.score);
  return matches.map((m) => m.item);
}
