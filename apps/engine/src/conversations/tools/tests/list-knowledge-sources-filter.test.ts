import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { knowledgeSources } from "../../../db/schema/knowledge_sources.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { makeToolCtx, seedTenant, seedTimestamp } from "../../../test-helpers/seed.ts";
import { listKnowledgeSourcesTool } from "../engine-api/knowledge-sources.ts";
import type { ToolContext } from "../index.ts";

let testDb: TestDb;
let tenantId: string;
let emptyTenantId: string;

const sources = [
  { id: "10000000-0000-4000-8000-000000000001", name: "TE-KO2", category: "te-ko2" },
  { id: "10000000-0000-4000-8000-000000000002", name: "Platform", category: "platform" },
];

function ctxFor(tenant_id: string): ToolContext {
  return makeToolCtx({ db: testDb.db, tenant_id });
}

async function run(ctx: ToolContext, args: { category?: string }) {
  const result = await listKnowledgeSourcesTool.execute(ctx, args);
  return result.data as Record<string, unknown>;
}

beforeAll(async () => {
  testDb = await createTestDb("list_knowledge_sources_filter");
  tenantId = (await seedTenant(testDb.db)).id;
  emptyTenantId = (await seedTenant(testDb.db)).id;
  await testDb.db.insert(knowledgeSources).values(
    sources.map((source, index) => ({
      ...source,
      tenant_id: tenantId,
      slug: source.name.toLowerCase(),
      description: "",
      source_type: "inline",
      source_uri: `${source.name.toLowerCase()}.md`,
      version: "1",
      chunk_count: 1,
      created_at: seedTimestamp(sources.length - index),
      updated_at: seedTimestamp(sources.length - index),
    })),
  );
});

afterAll(async () => {
  await testDb.cleanup();
});

describe("list_knowledge_sources with a category filter", () => {
  test("an empty filtered list says what exists elsewhere and how to look again", async () => {
    const data = await run(ctxFor(tenantId), { category: "intake-test" });
    expect(data.sources).toEqual([]);
    expect(data.category_filter).toBe("intake-test");
    expect(data.total_sources).toBe(2);
    expect(data.categories).toEqual(["platform", "te-ko2"]);
    expect(String(data.hint)).toContain("sources_in_other_categories");
    expect(data.sources_in_other_categories).toEqual([
      { id: sources[0]?.id, name: "TE-KO2", category: "te-ko2" },
      { id: sources[1]?.id, name: "Platform", category: "platform" },
    ]);
  });

  test("a matching filter lists the match and gives no hint", async () => {
    const data = await run(ctxFor(tenantId), { category: "te-ko2" });
    expect((data.sources as unknown[]).length).toBe(1);
    expect(data.total_sources).toBe(2);
    expect(data.hint).toBeUndefined();
    expect(data.sources_in_other_categories).toBeUndefined();
  });

  test("without a filter the answer carries no filter context", async () => {
    const data = await run(ctxFor(tenantId), {});
    expect((data.sources as unknown[]).length).toBe(2);
    expect(data.category_filter).toBeUndefined();
    expect(data.total_sources).toBeUndefined();
    expect(data.hint).toBeUndefined();
  });

  test("an empty workspace gets no misleading hint", async () => {
    const data = await run(ctxFor(emptyTenantId), { category: "intake-test" });
    expect(data.sources).toEqual([]);
    expect(data.hint).toBeUndefined();
  });
});
