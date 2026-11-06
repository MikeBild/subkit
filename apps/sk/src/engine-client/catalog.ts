import type { EngineClient } from "../engine-client.ts";
import type { ApiBody } from "./http.ts";

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
  async listCategories(this: EngineClient): Promise<{ categories: CatalogCategoryUsage[] }> {
    const { data } = await this.api.GET("/v1/categories");
    return data as { categories: CatalogCategoryUsage[] };
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
    const body = {
      to,
      purpose: source.purpose ?? null,
      aliases: source.aliases ?? [],
      expected_source_revision: source.revision ?? null,
      expected_target_revision: target?.revision ?? null,
      preserve_purpose: true,
    } as ApiBody<"/v1/categories/{name}/rename", "post">;
    const { data } = await this.api.POST("/v1/categories/{name}/rename", {
      params: { path: { name } },
      body,
    });
    return data as {
      from: string;
      to: string;
      total: number;
      moved: CatalogCategoryUsage["counts"];
    };
  },
  async patchWorkflowMetadata(
    this: EngineClient,
    id: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { data } = await this.api.PATCH("/v1/workflows/{id}/metadata", {
      params: { path: { id } },
      body: body as ApiBody<"/v1/workflows/{id}/metadata", "patch">,
    });
    return data as Record<string, unknown>;
  },
  async patchFile(
    this: EngineClient,
    id: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { data } = await this.api.PATCH("/v1/files/{id}", {
      params: { path: { id } },
      body: body as ApiBody<"/v1/files/{id}", "patch">,
    });
    return data as Record<string, unknown>;
  },
};
