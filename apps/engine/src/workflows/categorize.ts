// Derived catalog categories.
//
// Workflows carry no stored grouping column: a category is computed from the
// slug corpus, so the blocks a user sees emerge from the names already in the
// catalog rather than from a curated list that goes stale. This is the single
// source of truth for every list surface (HTTP, MCP, sk-cli, chat fast path)
// and for the authoring naming grounding, so a workflow lands in the same
// block wherever it is shown and wherever it is named.
//
// The category is a function of the WHOLE catalog, not of one row: adding a
// third sibling promotes its family out of `other` into its own block. That is
// the intended "categories emerge" behaviour, and it is why the category can
// not be pushed into SQL — callers derive it over the loaded page.

/**
 * How many members a shared prefix needs before it earns its own block.
 *
 * Below this the members would each render as a block of one, which reads
 * worse than a flat list — on the real catalog a naive prefix split produced
 * a dozen single-item blocks (`corsica`, `droplet`, `ga4`, `web`, …). Those
 * collect in `UNCATEGORIZED` instead.
 */
export const MIN_CATEGORY_SIZE = 3;

/** Catch-all for slugs with no qualifying shared prefix. */
export const UNCATEGORIZED = "other";

/**
 * Every dash-boundary prefix of a slug, shortest first, including the slug
 * itself — a slug can head its own family (`notion` alongside
 * `notion-search-pages`).
 */
function prefixesOf(slug: string): string[] {
  const segments = slug.split("-").filter(Boolean);
  const out: string[] = [];
  for (let i = 1; i <= segments.length; i++) out.push(segments.slice(0, i).join("-"));
  return out;
}

/**
 * Map each slug to its category.
 *
 * A longer prefix can never match more slugs than a shorter one, so the
 * widest qualifying family always sits at the shortest prefix. Iterating
 * shortest-first and keeping `>=` therefore selects the LONGEST prefix among
 * those tied on that widest membership: `mission-control` (7) wins over the
 * equally-large but meaningless fragment `mission` (7), while the narrower
 * `mission-control-reporting-rollup` (4) never displaces it. Slugs with no
 * qualifying prefix map to `UNCATEGORIZED`.
 */
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

/**
 * Group items into the ordered blocks every surface renders: biggest family
 * first so the catalog's centre of gravity is on screen, `other` always last.
 * Ties break on the category name (plain codepoint order, not `localeCompare`,
 * so the output is locale-independent for the determinism gate).
 */
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
