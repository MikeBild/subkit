// Knowledge-source tag contract: normalization plus the structural
// (namespace-prefixed) tag rules shared by every tag writer in the
// subsystem.

/** REPLACE-semantics tag normalizer: trims, drops empties, dedupes
 *  case-insensitively (keeping first-seen casing), and caps to 20. This
 *  is the single guard against the array-doubling class of bug — tags are
 *  always set to a deduped replacement set, never concatenated. */
export function dedupeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag.slice(0, 40));
    if (out.length >= 20) break;
  }
  return out;
}

/** Namespaced tags — an identifier PREFIX followed directly by a colon
 *  (`domain:<slug>`, any `<ns>:`) — are structural routing keys: the agent
 *  briefing and tag-filtered search select on them, so the `<ns>:` shape is
 *  reserved for routing. Case-insensitive so an existing `Domain:x` cannot
 *  silently turn topical; a colon later in the tag (`note: x`) does not
 *  count. */
export function isStructuralTag(tag: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*:/i.test(tag.trim());
}

/** Tag merge for MACHINE-regenerated tags (analysis): structural tags
 *  already on the source always survive — wiping them made every analyzed
 *  source silently drop out of its domain — and analysis replaces only the
 *  plain topical remainder. An explicit operator PATCH
 *  (`updateKnowledgeSource`) deliberately bypasses this and replaces tags
 *  wholesale: that is the one way to re-home a source out of a domain. */
export function mergeStructuralTags(
  existing: readonly string[],
  generated: readonly string[],
): string[] {
  return dedupeTags([...existing.filter(isStructuralTag), ...generated]);
}
