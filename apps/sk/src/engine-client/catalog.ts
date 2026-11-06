import type { components } from "@cli-core/engine-api/openapi.d.ts";
import type { EngineClient } from "../engine-client.ts";
import type { ApiBody } from "./http.ts";

type Schemas = components["schemas"];

export type CatalogCategoryUsage = Schemas["CategoryUsage"];

export const catalogMethods = {
  async listCategories(this: EngineClient): Promise<Schemas["CategoryListResponse"]> {
    const { data } = await this.api.GET("/v1/categories");
    return data as Schemas["CategoryListResponse"];
  },
  async renameCategory(
    this: EngineClient,
    name: string,
    to: string,
  ): Promise<Schemas["RenameCategoryResponse"]> {
    const { categories } = await this.listCategories();
    const source = categories.find((category) => category.category === name);
    if (!source)
      throw new Error("Source category is unavailable; list categories and review the name.");
    const target = categories.find((category) => category.category === to);
    const body: ApiBody<"/v1/categories/{name}/rename", "post"> = {
      to,
      purpose: source.purpose,
      aliases: source.aliases,
      expected_source_revision: source.revision,
      expected_target_revision: target?.revision ?? null,
      preserve_purpose: true,
    };
    const { data } = await this.api.POST("/v1/categories/{name}/rename", {
      params: { path: { name } },
      body,
    });
    return data as Schemas["RenameCategoryResponse"];
  },
  async patchWorkflowMetadata(
    this: EngineClient,
    id: string,
    body: ApiBody<"/v1/workflows/{id}/metadata", "patch">,
  ): Promise<Schemas["WorkflowDetail"]> {
    const { data } = await this.api.PATCH("/v1/workflows/{id}/metadata", {
      params: { path: { id } },
      body,
    });
    return data as Schemas["WorkflowDetail"];
  },
  async patchFile(
    this: EngineClient,
    id: string,
    body: ApiBody<"/v1/files/{id}", "patch">,
  ): Promise<Schemas["File"]> {
    const { data } = await this.api.PATCH("/v1/files/{id}", {
      params: { path: { id } },
      body,
    });
    return data as Schemas["File"];
  },
};
