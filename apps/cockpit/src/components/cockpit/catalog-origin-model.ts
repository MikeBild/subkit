import type { CatalogKind } from "./catalog-metadata-model";

export function catalogAICount(
  categories: readonly { llm_counts?: Partial<Record<CatalogKind, number>> }[] | undefined,
  kind: CatalogKind,
) {
  if (!categories) return null;
  let total = 0;
  for (const category of categories) {
    const count = category.llm_counts?.[kind];
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) return null;
    total += count;
  }
  return total;
}
