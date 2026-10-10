import type { CatalogKind } from "./catalog-metadata-model";

export interface CategoryUsage {
  category: string;
  total: number;
  counts: Record<CatalogKind, number> & { intake?: number };
  llm_counts?: Partial<Record<CatalogKind, number>>;
  purpose?: string | null;
  purpose_source?: "human" | "llm" | null;
  aliases?: string[];
  revision?: number | null;
}

export function categoryMatches(category: CategoryUsage, query: string): boolean {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const text = [
    category.category,
    category.category.replaceAll("-", " "),
    category.purpose,
    ...(category.aliases ?? []),
  ]
    .join(" ")
    .toLocaleLowerCase();
  return words.every((word) => text.includes(word));
}

export function categoryEditPayload(
  source: CategoryUsage,
  target: CategoryUsage | undefined,
  to: string,
  purpose: string,
  aliases: string,
) {
  return {
    to,
    purpose: purpose.trim() || null,
    aliases: categoryAliases(aliases),
    expected_source_revision: source.revision ?? null,
    expected_target_revision: (to === source.category ? source.revision : target?.revision) ?? null,
  };
}

export function categoryAliases(value: string): string[] {
  const unique = new Map<string, string>();
  for (const part of value.split(",")) {
    const alias = part.normalize("NFKC").trim();
    if (alias && !unique.has(alias.toLocaleLowerCase()))
      unique.set(alias.toLocaleLowerCase(), alias);
  }
  return [...unique.values()];
}
