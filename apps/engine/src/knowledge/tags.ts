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

/** Namespaced tags — a NAMESPACE prefix (letters/digits/underscore,
 *  hyphens strictly inside, Unicode included so `domäne:blog` counts), a
 *  colon, and content directly after it (`domain:<slug>`, any `<ns>:x`)
 *  — are structural routing keys: the agent briefing and tag-filtered
 *  search select on them, so the `<ns>:` shape is reserved for routing.
 *  Prose and punctuation colons do not count: a space before the colon
 *  (`note about: chords`), a space after it (`note: x`), a trailing
 *  hyphen (`blog-:x`), or a non-name prefix (`q&a:faq`, `c++:tips`,
 *  `.net:core`) all mark plain topical tags that re-analysis may
 *  replace. Input is NFC-normalized first so a decomposed `domäne:blog`
 *  (combining diaeresis) classifies the same as the composed form. */
export function isStructuralTag(tag: string): boolean {
  return /^[\p{L}\p{N}_]([\p{L}\p{N}_-]*[\p{L}\p{N}_])?:\S/u.test(tag.trim().normalize("NFC"));
}

/** Tag merge for MACHINE-regenerated tags (analysis): structural tags
 *  already on the source always survive — wiping them made every analyzed
 *  source silently drop out of its domain — and analysis replaces only the
 *  plain topical remainder. Structural-shaped tags coming OUT of the model
 *  are dropped: analysis must never mint a new routing key (which would
 *  then be pinned forever by this very merge). An explicit operator PATCH
 *  (`updateKnowledgeSource`) deliberately bypasses this and replaces tags
 *  wholesale: that is the one way to re-home a source out of a domain. */
export function mergeStructuralTags(
  existing: readonly string[],
  generated: readonly string[],
): string[] {
  return dedupeTags([
    ...existing.filter(isStructuralTag),
    ...generated.filter((t) => !isStructuralTag(t)),
  ]);
}
