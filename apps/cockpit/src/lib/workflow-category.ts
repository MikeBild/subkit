export const UNCATEGORIZED = "other";

export const MIN_CATEGORY_SIZE = 3;

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

export function memberCountAfterMove(
  counts: ReadonlyMap<string, number>,
  currentCategory: string,
  category: string,
): number {
  if (category === UNCATEGORIZED) return counts.get(category) ?? 0;
  const existing = counts.get(category) ?? 0;
  return currentCategory === category ? existing : existing + 1;
}

export function humanizeCategory(category: string, uncategorized: string): string {
  if (!category.trim() || category === UNCATEGORIZED) return uncategorized;
  return category
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}
