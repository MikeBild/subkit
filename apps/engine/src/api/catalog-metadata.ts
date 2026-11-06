import { z } from "@hono/zod-openapi";
import { scrubString } from "../logging/scrub-secrets.ts";

export const UNCATEGORIZED = "other";

export const PLATFORM_CATEGORY = "platform";

export const CATALOG_GROUP_BY = ["category"] as const;

export type CatalogGroupBy = (typeof CATALOG_GROUP_BY)[number];

export const CatalogGroupBySchema = z
  .enum(CATALOG_GROUP_BY)
  .describe("Order by catalog category first, uncategorized last, then by `sort`");

export const CATEGORY_MAX_LENGTH = 40;

const DESCRIPTION_MAX_LENGTH = 2000;

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

export const CATEGORY_KINDS = [...CATALOG_KINDS, "intake"] as const;

export type CategoryKind = (typeof CATEGORY_KINDS)[number];

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

export const AcceptDescriptionSchema = z
  .boolean()
  .describe(
    "Accept the supplied unchanged description as human-owned. Requires the exact current nonempty description; stale text is rejected.",
  );

export class DescriptionAcceptanceError extends Error {
  constructor(readonly code: "description_acceptance_invalid" | "description_changed") {
    super(
      code === "description_changed"
        ? "The description changed; read it again before accepting it."
        : "Accepting a description requires its exact nonempty text.",
    );
    this.name = "DescriptionAcceptanceError";
  }
}

export function descriptionAcceptanceValid(patch: {
  accept_description?: boolean | undefined;
  description?: string | null | undefined;
}): boolean {
  return (
    !patch.accept_description ||
    (typeof patch.description === "string" && patch.description.trim().length > 0)
  );
}

export const CatalogMetadataPatchSchema = z
  .object({
    description: DescriptionSchema.nullable().optional(),
    accept_description: AcceptDescriptionSchema.optional(),
    category: CategorySchema.nullable().optional(),
  })
  .refine(descriptionAcceptanceValid, {
    message: "accept_description requires the exact nonempty description",
    path: ["accept_description"],
  })
  .openapi("CatalogMetadataPatch");

export type CatalogMetadataPatch = z.infer<typeof CatalogMetadataPatchSchema>;

const CatalogMetadataViewSchema = z
  .object({
    description: z.string().nullable(),
    category: z.string(),
    description_source: CatalogSourceSchema,
    category_source: CatalogSourceSchema,
  })
  .openapi("CatalogMetadata");

type CatalogMetadataView = z.infer<typeof CatalogMetadataViewSchema>;

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
  current: { description: string | null; category: string; description_source?: string },
  patch: CatalogMetadataPatch,
): CatalogMetadataColumns | null {
  if (patch.accept_description) {
    if (typeof patch.description !== "string" || !patch.description.trim())
      throw new DescriptionAcceptanceError("description_acceptance_invalid");
    if (patch.description !== current.description)
      throw new DescriptionAcceptanceError("description_changed");
  }
  const write = humanMetadataWrite(patch);
  const out: CatalogMetadataColumns = {};
  if (write.description_source !== undefined) {
    const unchanged =
      write.description_source === "human" && write.description === (current.description ?? null);
    if (patch.accept_description) {
      if (current.description_source !== "human") {
        out.description = current.description;
        out.description_source = "human";
      }
    } else if (!unchanged) {
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

interface CategoryBlock<T> {
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

export const CategoryMetadataSchema = z.object({
  purpose: z.string().max(DESCRIPTION_MAX_LENGTH).nullable(),
  purpose_source: CatalogSourceSchema.nullable(),
  aliases: z.array(z.string().trim().min(1).max(80)).max(32),
  revision: z.number().int().positive().nullable(),
});

export const CategoryEditSchema = z
  .object({
    to: CategorySchema,
    purpose: z.string().trim().max(DESCRIPTION_MAX_LENGTH).nullable(),
    aliases: z.array(z.string().trim().min(1).max(80)).max(32),
    preserve_purpose: z.boolean().optional(),
    expected_source_revision: z.number().int().positive().nullable(),
    expected_target_revision: z.number().int().positive().nullable(),
  })
  .strict();

export function normalizeCategoryAliases(values: readonly string[]): string[] {
  const seen = new Set<string>();
  return values
    .map((value) => value.normalize("NFKC").trim())
    .filter((value) => {
      const key = value.toLocaleLowerCase("en-US");
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
