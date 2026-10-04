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

export function isStructuralTag(tag: string): boolean {
  return /^[\p{L}\p{N}_]([\p{L}\p{N}_-]*[\p{L}\p{N}_])?:\S/u.test(tag.trim().normalize("NFC"));
}

export function mergeStructuralTags(
  existing: readonly string[],
  generated: readonly string[],
): string[] {
  return dedupeTags([
    ...existing.filter(isStructuralTag),
    ...generated.filter((t) => !isStructuralTag(t)),
  ]);
}
