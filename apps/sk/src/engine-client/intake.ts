import type { EngineClient } from "../engine-client.ts";
import type { ApiBody, ApiQuery } from "./http.ts";

export interface IntakeItem {
  id: string;
  category: string;
  title: string;
  state: "collected" | "reviewing" | "admitted" | "discarded";
  version: number;
  original_snapshot: {
    origin: "capture" | "restored_draft" | "note" | "session";
    source_url?: string;
    captured_at: string;
  };
}

export const intakeMethods = {
  async getDefaultIntakeCategory(this: EngineClient): Promise<{ category: string }> {
    const { data } = await this.api.GET("/v1/intake/default-category");
    return data as { category: string };
  },
  async setDefaultIntakeCategory(
    this: EngineClient,
    category: string,
  ): Promise<{ category: string }> {
    const { data } = await this.api.PATCH("/v1/intake/default-category", {
      body: { category } as ApiBody<"/v1/intake/default-category", "patch">,
    });
    return data as { category: string };
  },
  async listIntakeItems(
    this: EngineClient,
    query: { category?: string; state?: IntakeItem["state"] },
  ): Promise<{ items: IntakeItem[]; total?: number }> {
    const { data } = await this.api.GET("/v1/intake/items", {
      params: { query: query as ApiQuery<"/v1/intake/items", "get"> },
    });
    return data as { items: IntakeItem[]; total?: number };
  },
  async getIntakeItem(this: EngineClient, id: string): Promise<IntakeItem> {
    const { data } = await this.api.GET("/v1/intake/items/{id}", { params: { path: { id } } });
    return data as IntakeItem;
  },
  async patchIntakeItem(
    this: EngineClient,
    id: string,
    input: {
      expected_version: number;
      category?: string;
      state?: "collected" | "discarded";
    },
  ): Promise<IntakeItem> {
    const { data } = await this.api.PATCH("/v1/intake/items/{id}", {
      params: { path: { id } },
      body: input as ApiBody<"/v1/intake/items/{id}", "patch">,
    });
    return data as IntakeItem;
  },
};
