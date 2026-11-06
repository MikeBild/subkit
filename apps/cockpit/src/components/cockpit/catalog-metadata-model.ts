import { UNCATEGORIZED } from "@/lib/workflow-category";

export type CatalogKind = "workflow" | "connector" | "knowledge_source" | "skill" | "file";

export interface CatalogMetadataRecord {
  name?: unknown;
  filename?: unknown;
  title?: unknown;
  display_name?: unknown;
  description?: unknown;
  category?: unknown;
  description_source?: unknown;
  category_source?: unknown;
}

interface CatalogMetadataDraft {
  description: string;
  category: string;
}

const CATEGORY_MAX_LENGTH = 40;
const CATEGORY_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function normalizeCategoryInput(raw: string): string | null {
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

export function recordDescription(record: CatalogMetadataRecord | undefined): string {
  return typeof record?.description === "string" ? record.description : "";
}

export function recordCategory(record: CatalogMetadataRecord | undefined): string {
  return typeof record?.category === "string" && record.category ? record.category : UNCATEGORIZED;
}

export function writtenByAssistant(record: CatalogMetadataRecord | undefined): boolean {
  return record?.description_source === "llm" && recordDescription(record).trim() !== "";
}

export interface MetadataPatch {
  description?: string | null;
  category?: string | null;
}

export function metadataPatch(
  record: CatalogMetadataRecord | undefined,
  draft: CatalogMetadataDraft,
): MetadataPatch | null {
  const patch: MetadataPatch = {};

  const description = draft.description.trim();
  if (description !== recordDescription(record).trim()) patch.description = description || null;
  const category = draft.category && draft.category !== UNCATEGORIZED ? draft.category : null;
  const current = recordCategory(record);
  if ((category ?? UNCATEGORIZED) !== current) patch.category = category;
  return Object.keys(patch).length > 0 ? patch : null;
}

const RESERVED_CATEGORY = "platform";

export function categoryChoices(vocabulary: readonly string[], current: string): string[] {
  const named = [...new Set([...vocabulary, current])].filter(
    (c) => c && c !== UNCATEGORIZED && c !== RESERVED_CATEGORY,
  );
  return [...named.sort(), UNCATEGORIZED];
}
