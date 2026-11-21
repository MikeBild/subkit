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

export type CatalogCreatedBy = "all" | "ai" | "person";

export const CATALOG_CREATED_BY_PARAM = "created_by";
export const CATALOG_CREATED_BY_FILTER = "catalog-created-by";

export function isCatalogCreatedBy(value: string): value is CatalogCreatedBy {
  return value === "all" || value === "ai" || value === "person";
}

export function createdByDescriptionSource(value: CatalogCreatedBy): "llm" | "human" | undefined {
  if (value === "ai") return "llm";
  if (value === "person") return "human";
  return undefined;
}
