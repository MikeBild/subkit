import type { EngineClient } from "../engine-client.ts";

export interface CatalogCategoryUsage {
  category: string;
  total: number;
  counts: Record<"workflow" | "connector" | "knowledge_source" | "skill" | "file", number>;
}

export const catalogMethods = {
  listCategories(this: EngineClient): Promise<{ categories: CatalogCategoryUsage[] }> {
    return this.request("GET", "/v1/categories");
  },
  renameCategory(
    this: EngineClient,
    name: string,
    to: string,
  ): Promise<{ from: string; to: string; total: number; moved: CatalogCategoryUsage["counts"] }> {
    return this.request("POST", `/v1/categories/${encodeURIComponent(name)}/rename`, { to });
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
