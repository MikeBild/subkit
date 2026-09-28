/**
 * Categories are derived from the slug corpus, not stored on the row, so
 * moving a workflow into another block means renaming its slug prefix. The
 * cockpit mirrors the engine's rule here to show the resulting slug before the
 * rename is confirmed.
 */
export const UNCATEGORIZED = "other";

/** A prefix needs this many members before it becomes a visible block. */
export const MIN_CATEGORY_SIZE = 3;

/** The slug the workflow gets when it moves into `category`. */
export function recategorizedSlug(slug: string, currentCategory: string, category: string): string {
  const remainder =
    currentCategory !== UNCATEGORIZED && slug.startsWith(`${currentCategory}-`)
      ? slug.slice(currentCategory.length + 1)
      : slug;
  if (category === UNCATEGORIZED) return remainder;
  return remainder.startsWith(`${category}-`) || remainder === category
    ? remainder
    : `${category}-${remainder}`;
}

/**
 * How many workflows would share the target prefix afterwards. Below
 * MIN_CATEGORY_SIZE the block stays invisible, and the dialog says so instead
 * of promising a chip that will not appear.
 */
export function memberCountAfterMove(
  counts: ReadonlyMap<string, number>,
  currentCategory: string,
  category: string,
): number {
  if (category === UNCATEGORIZED) return counts.get(category) ?? 0;
  const existing = counts.get(category) ?? 0;
  return currentCategory === category ? existing : existing + 1;
}

/**
 * A block's name as a reader sees it.
 *
 * A category IS a slug prefix (§10: categories come from the data), so the
 * column printed `mission-control` — a machine word where a name belongs
 * (§5). The name is derived from the slug, never from a table of known
 * blocks: a block created tomorrow reads as well as one that exists today.
 * The uncategorised family has its own word, handed in by the caller.
 */
export function humanizeCategory(category: string, uncategorized: string): string {
  if (!category.trim() || category === UNCATEGORIZED) return uncategorized;
  return category
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}
