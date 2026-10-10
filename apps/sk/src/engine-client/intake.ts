import type { EngineClient } from "../engine-client.ts";

export interface IntakeItem {
  id: string;
  category: string;
  title: string;
  state: "collected" | "reviewing" | "admitted" | "discarded";
  version: number;
  original_snapshot: { source_url: string; captured_at: string };
}

export const intakeMethods = {
  getDefaultIntakeCategory(this: EngineClient): Promise<{ category: string }> {
    return this.request("GET", "/v1/intake/default-category");
  },
  setDefaultIntakeCategory(this: EngineClient, category: string): Promise<{ category: string }> {
    return this.request("PATCH", "/v1/intake/default-category", { category });
  },
  listIntakeItems(
    this: EngineClient,
    query: { category?: string; state?: IntakeItem["state"] },
  ): Promise<{ items: IntakeItem[]; total?: number }> {
    return this.request("GET", "/v1/intake/items", undefined, query);
  },
  getIntakeItem(this: EngineClient, id: string): Promise<IntakeItem> {
    return this.request("GET", `/v1/intake/items/${encodeURIComponent(id)}`);
  },
  patchIntakeItem(
    this: EngineClient,
    id: string,
    input: {
      expected_version: number;
      category?: string;
      state?: "collected" | "discarded";
    },
  ): Promise<IntakeItem> {
    return this.request("PATCH", `/v1/intake/items/${encodeURIComponent(id)}`, input);
  },
};
