export const UNCATEGORIZED = "other";

export function humanizeCategory(category: string, uncategorized: string): string {
  if (!category.trim() || category === UNCATEGORIZED) return uncategorized;
  return category
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}
