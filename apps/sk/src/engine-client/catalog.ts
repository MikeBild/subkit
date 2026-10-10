import type { EngineClient } from "../engine-client.ts";

export interface CatalogCategoryUsage {
  category: string;
  total: number;
  counts: Record<"workflow" | "connector" | "knowledge_source" | "skill" | "file", number>;
  purpose: string | null;
  purpose_source: "human" | "llm" | null;
  aliases: string[];
  revision: number | null;
}

export const catalogMethods = {
  listCategories(this: EngineClient): Promise<{ categories: CatalogCategoryUsage[] }> {
    return this.request("GET", "/v1/categories");
  },
  async renameCategory(
    this: EngineClient,
    name: string,
    to: string,
  ): Promise<{ from: string; to: string; total: number; moved: CatalogCategoryUsage["counts"] }> {
    const { categories } = await this.listCategories();
    const source = categories.find((category) => category.category === name);
    if (!source)
      throw new Error("Source category is unavailable; list categories and review the name.");
    const target = categories.find((category) => category.category === to);
    return this.request("POST", `/v1/categories/${encodeURIComponent(name)}/rename`, {
      to,
      purpose: source.purpose ?? null,
      aliases: source.aliases ?? [],
      expected_source_revision: source.revision ?? null,
      expected_target_revision: target?.revision ?? null,
      preserve_purpose: true,
    });
  },
  patchWorkflowMetadata(
    this: EngineClient,
    id: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request("PATCH", `/v1/workflows/${encodeURIComponent(id)}/metadata`, body);
  },
  patchFile(
    this: EngineClient,
    id: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request("PATCH", `/v1/files/${encodeURIComponent(id)}`, body);
  },
};
