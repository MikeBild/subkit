import { z } from "@hono/zod-openapi";
import { scrubString } from "../logging/scrub-secrets.ts";

export const UNCATEGORIZED = "other";

export const PLATFORM_CATEGORY = "platform";

export const CATEGORY_MAX_LENGTH = 40;

export const DESCRIPTION_MAX_LENGTH = 2000;

export const LISTED_DESCRIPTION_MAX = 300;

export function listedDescription(text: string | null | undefined): string | null {
  const flat = text?.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length > LISTED_DESCRIPTION_MAX
    ? `${flat.slice(0, LISTED_DESCRIPTION_MAX - 1).trimEnd()}…`
    : flat;
}

export const CATEGORY_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const CATALOG_KINDS = [
  "workflow",
  "connector",
  "knowledge_source",
  "skill",
  "file",
] as const;

export type CatalogKind = (typeof CATALOG_KINDS)[number];

export const CatalogSourceSchema = z.enum(["human", "llm"]).openapi("CatalogMetadataSource");

export type CatalogSource = z.infer<typeof CatalogSourceSchema>;

export function normalizeCategory(raw: string): string | null {
  const slug = raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, CATEGORY_MAX_LENGTH)
    .replace(/-+$/g, "");
  return CATEGORY_PATTERN.test(slug) ? slug : null;
}

export const CategoryFilterSchema = z
  .string()
  .trim()
  .min(1)
  .max(CATEGORY_MAX_LENGTH)
  .regex(CATEGORY_PATTERN, "lowercase words joined by single dashes, e.g. `billing-reports`")
  .openapi("CatalogCategoryFilter", {
    description: "Only objects in this catalog block (see `GET /v1/categories`).",
  });

export const CategorySchema = CategoryFilterSchema.refine(
  (value) => value !== PLATFORM_CATEGORY,
  `\`${PLATFORM_CATEGORY}\` is reserved for the engine's own guidance`,
).openapi("CatalogCategory", {
  description:
    "The catalog block this object belongs to. One vocabulary is shared by workflows, connectors, knowledge sources, skills and files of a tenant; `GET /v1/categories` lists it.",
});

export const DescriptionSchema = z
  .string()
  .max(DESCRIPTION_MAX_LENGTH)
  .openapi("CatalogDescription", {
    description:
      "What this object is for, in plain language. The assistant reads it to pick the right object; an empty string hands the text back to automatic description.",
  });

export const CatalogMetadataPatchSchema = z
  .object({
    description: DescriptionSchema.nullable().optional(),
    category: CategorySchema.nullable().optional(),
  })
  .openapi("CatalogMetadataPatch");

export type CatalogMetadataPatch = z.infer<typeof CatalogMetadataPatchSchema>;

export const CatalogMetadataViewSchema = z
  .object({
    description: z.string().nullable(),
    category: z.string(),
    description_source: CatalogSourceSchema,
    category_source: CatalogSourceSchema,
  })
  .openapi("CatalogMetadata");

export type CatalogMetadataView = z.infer<typeof CatalogMetadataViewSchema>;

export const UNDESCRIBED_METADATA: CatalogMetadataView = {
  description: null,
  category: UNCATEGORIZED,
  description_source: "llm",
  category_source: "llm",
};

export interface CatalogMetadataColumns {
  description?: string | null;
  description_source?: CatalogSource;
  category?: string;
  category_source?: CatalogSource;
  catalog_input_hash?: null;
  catalog_described_at?: null;
}

export function humanMetadataWrite(patch: CatalogMetadataPatch): CatalogMetadataColumns {
  const out: CatalogMetadataColumns = {};
  if (patch.description !== undefined) {
    const text = scrubString(patch.description?.trim() ?? "").trim();
    out.description = text === "" ? null : text;
    out.description_source = text === "" ? "llm" : "human";
  }
  if (patch.category !== undefined) {
    const category = patch.category?.trim() ?? "";
    out.category = category === "" ? UNCATEGORIZED : category;
    out.category_source = category === "" ? "llm" : "human";
  }
  if (out.description_source === "llm" || out.category_source === "llm") {
    out.catalog_input_hash = null;
    out.catalog_described_at = null;
  }
  return out;
}

export function metadataChange(
  current: { description: string | null; category: string },
  patch: CatalogMetadataPatch,
): CatalogMetadataColumns | null {
  const write = humanMetadataWrite(patch);
  const out: CatalogMetadataColumns = {};
  if (write.description_source !== undefined) {
    const unchanged =
      write.description_source === "human" && write.description === (current.description ?? null);
    if (!unchanged) {
      out.description = write.description ?? null;
      out.description_source = write.description_source;
    }
  }
  if (write.category_source !== undefined) {
    const unchanged = write.category_source === "human" && write.category === current.category;
    if (!unchanged && write.category !== undefined) {
      out.category = write.category;
      out.category_source = write.category_source;
    }
  }
  if (out.description_source === "llm" || out.category_source === "llm") {
    out.catalog_input_hash = null;
    out.catalog_described_at = null;
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function catalogMetadataView(row: {
  description: string | null;
  category: string;
  description_source: string;
  category_source: string;
}): CatalogMetadataView {
  return {
    description: row.description,
    category: row.category,
    description_source: row.description_source === "human" ? "human" : "llm",
    category_source: row.category_source === "human" ? "human" : "llm",
  };
}

export function compareCategoryCounts(
  a: { category: string; count: number },
  b: { category: string; count: number },
): number {
  if (a.category === UNCATEGORIZED) return 1;
  if (b.category === UNCATEGORIZED) return -1;
  if (a.count !== b.count) return b.count - a.count;
  return a.category < b.category ? -1 : a.category > b.category ? 1 : 0;
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
    .sort((a, b) =>
      compareCategoryCounts(
        { category: a.category, count: a.items.length },
        { category: b.category, count: b.items.length },
      ),
    );
}
