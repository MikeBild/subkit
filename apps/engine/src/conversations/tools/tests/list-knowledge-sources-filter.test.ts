import { describe, expect, test } from "bun:test";
import { listKnowledgeSourcesTool } from "../engine-api/knowledge-sources.ts";
import type { ToolContext } from "../index.ts";

function ctxWith(sources: Array<{ id: string; name: string; category: string }>): ToolContext {
  const rows = sources.map((source) => ({
    ...source,
    slug: source.name.toLowerCase(),
    description: "",
    tags: [],
    scope: "global",
    status: "active",
    chunk_count: 1,
  }));
  return {
    engineClient: { knowledgeSources: { list: async () => rows } },
  } as unknown as ToolContext;
}

const sources = [
  { id: "10000000-0000-4000-8000-000000000001", name: "TE-KO2", category: "te-ko2" },
  { id: "10000000-0000-4000-8000-000000000002", name: "Platform", category: "platform" },
];

async function run(ctx: ToolContext, args: { category?: string }) {
  const result = await listKnowledgeSourcesTool.execute(ctx, args);
  return result.data as Record<string, unknown>;
}

describe("list_knowledge_sources with a category filter", () => {
  test("an empty filtered list says what exists elsewhere and how to look again", async () => {
    const data = await run(ctxWith(sources), { category: "intake-test" });
    expect(data.sources).toEqual([]);
    expect(data.category_filter).toBe("intake-test");
    expect(data.total_sources).toBe(2);
    expect(data.categories).toEqual(["platform", "te-ko2"]);
    expect(String(data.hint)).toContain("without category");
  });

  test("a matching filter lists the match and gives no hint", async () => {
    const data = await run(ctxWith(sources), { category: "te-ko2" });
    expect((data.sources as unknown[]).length).toBe(1);
    expect(data.total_sources).toBe(2);
    expect(data.hint).toBeUndefined();
  });

  test("without a filter the answer carries no filter context", async () => {
    const data = await run(ctxWith(sources), {});
    expect((data.sources as unknown[]).length).toBe(2);
    expect(data.category_filter).toBeUndefined();
    expect(data.total_sources).toBeUndefined();
    expect(data.hint).toBeUndefined();
  });

  test("an empty workspace gets no misleading hint", async () => {
    const data = await run(ctxWith([]), { category: "intake-test" });
    expect(data.sources).toEqual([]);
    expect(data.hint).toBeUndefined();
  });
});
