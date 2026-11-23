export const SEARCH_HINT_TAG_LIMIT = 20;

export interface HintSource {
  status: string;
  scope: string;
  workflow_id: string | null;
  tags: readonly string[];
}

export function availableTags(
  sources: readonly HintSource[],
  workflow_id: string | null | undefined,
  limit = SEARCH_HINT_TAG_LIMIT,
): string[] {
  const counts = new Map<string, { tag: string; n: number }>();
  for (const source of sources) {
    if (source.status !== "active") continue;
    if (source.scope === "workflow" && source.workflow_id !== (workflow_id ?? null)) continue;
    for (const raw of new Set(source.tags.map((t) => t.trim()).filter(Boolean))) {
      const key = raw.toLowerCase();
      const entry = counts.get(key) ?? { tag: raw, n: 0 };
      entry.n += 1;
      counts.set(key, entry);
    }
  }
  return [...counts.values()]
    .sort((a, b) => b.n - a.n || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0))
    .slice(0, limit)
    .map((e) => e.tag);
}

export function emptySearchHint(
  tags: readonly string[],
  requested: readonly string[] = [],
): string {
  const known = new Set(tags.map((t) => t.toLowerCase()));
  const unknown = requested.filter((t) => !known.has(t.trim().toLowerCase()));
  const unknownNote = unknown.length
    ? ` No source carries the tag${unknown.length === 1 ? "" : "s"} ${unknown.join(", ")}.`
    : "";
  if (tags.length === 0)
    return `No knowledge matched, and no knowledge source has tags yet.${unknownNote} Tell the person nothing was found instead of guessing.`;
  return `No knowledge matched.${unknownNote} Available tags: ${tags.join(", ")}. Retry once with a different query or one of these tags; if that finds nothing, tell the person nothing was found.`;
}
