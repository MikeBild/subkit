export const MIN_CATEGORY_SIZE = 3;

export const UNCATEGORIZED = "other";

function prefixesOf(slug: string): string[] {
  const segments = slug.split("-").filter(Boolean);
  const out: string[] = [];
  for (let i = 1; i <= segments.length; i++) out.push(segments.slice(0, i).join("-"));
  return out;
}

export function deriveCategories(slugs: readonly string[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const slug of slugs) {
    for (const prefix of prefixesOf(slug)) {
      counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    }
  }

  const out = new Map<string, string>();
  for (const slug of slugs) {
    let best: string | null = null;
    let bestCount = 0;
    for (const prefix of prefixesOf(slug)) {
      const count = counts.get(prefix) ?? 0;
      if (count < MIN_CATEGORY_SIZE) continue;
      if (count >= bestCount) {
        best = prefix;
        bestCount = count;
      }
    }
    out.set(slug, best ?? UNCATEGORIZED);
  }
  return out;
}

export interface CategoryBlock<T> {
  category: string;
  items: T[];
}

export function groupByCategory<T>(
  items: readonly T[],
  categoryOf: (item: T) => string,
): CategoryBlock<T>[] {
  const blocks = new Map<string, T[]>();
  for (const item of items) {
    const category = categoryOf(item);
    const bucket = blocks.get(category);
    if (bucket) bucket.push(item);
    else blocks.set(category, [item]);
  }
  return [...blocks.entries()]
    .map(([category, grouped]) => ({ category, items: grouped }))
    .sort((a, b) => {
      if (a.category === UNCATEGORIZED) return 1;
      if (b.category === UNCATEGORIZED) return -1;
      if (a.items.length !== b.items.length) return b.items.length - a.items.length;
      return a.category < b.category ? -1 : a.category > b.category ? 1 : 0;
    });
}
