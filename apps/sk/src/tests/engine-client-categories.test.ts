import { describe, expect, test } from "bun:test";
import type { components } from "@cli-core/engine-api/openapi.d.ts";
import type { CatalogCategoryUsage } from "../engine-client/catalog.ts";
import { EngineClient } from "../engine-client.ts";

const source: CatalogCategoryUsage = {
  category: "finance",
  purpose: "Invoices",
  purpose_source: "llm",
  aliases: ["Accounting"],
  revision: 3,
  total: 1,
  counts: { workflow: 1, connector: 0, knowledge_source: 0, skill: 0, file: 0, task: 0, intake: 0 },
  llm_counts: {
    workflow: 1,
    connector: 0,
    knowledge_source: 0,
    skill: 0,
    file: 0,
    task: 0,
    intake: 0,
  },
  intake_open: { collected: 0, reviewing: 0 },
};

function clientFor(categories: CatalogCategoryUsage[], status = 200) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const client = new EngineClient({
    engine_url: "https://engine.test",
    api_key: "test-key",
    tenant: "test-tenant",
    fetchImpl: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? "GET";
      calls.push({
        method,
        path: new URL(url).pathname,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });
      return Response.json(
        method === "GET"
          ? { categories }
          : status === 409
            ? { code: "conflict", message: "Category changed; review before retrying" }
            : { from: "finance", to: "accounts", total: 1, moved: source.counts },
        { status: method === "GET" ? 200 : status },
      );
    },
  });
  return { client, calls };
}

describe("category rename revision contract", () => {
  test("reads both revisions and preserves AI purpose ownership during a simple rename", async () => {
    const { client, calls } = clientFor([source, { ...source, category: "accounts", revision: 7 }]);
    await client.renameCategory("finance", "accounts");
    expect(calls).toEqual([
      { method: "GET", path: "/v1/categories", body: null },
      {
        method: "POST",
        path: "/v1/categories/finance/rename",
        body: {
          to: "accounts",
          purpose: "Invoices",
          aliases: ["Accounting"],
          expected_source_revision: 3,
          expected_target_revision: 7,
          preserve_purpose: true,
        } satisfies components["schemas"]["RenameCategoryBody"],
      },
    ]);
  });

  test("historical absence stays explicit and does not request purpose generation", async () => {
    const { client, calls } = clientFor([
      { ...source, purpose: null, revision: null, aliases: [] },
    ]);
    await client.renameCategory("finance", "accounts");
    expect(calls[1]?.body).toEqual({
      to: "accounts",
      purpose: null,
      aliases: [],
      expected_source_revision: null,
      expected_target_revision: null,
      preserve_purpose: true,
    } satisfies components["schemas"]["RenameCategoryBody"]);
  });

  test("does not submit an unavailable source or retry a revision conflict", async () => {
    const missing = clientFor([]);
    await expect(missing.client.renameCategory("finance", "accounts")).rejects.toThrow(
      "unavailable",
    );
    expect(missing.calls).toHaveLength(1);
    const conflict = clientFor([source], 409);
    await expect(conflict.client.renameCategory("finance", "accounts")).rejects.toThrow();
    expect(conflict.calls).toHaveLength(2);
  });
});
