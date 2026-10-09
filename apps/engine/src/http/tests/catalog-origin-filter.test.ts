import { afterAll, beforeAll, expect, test } from "bun:test";
import { connectors, files, knowledgeSources, skills, workflows } from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;
const category = "origin-fixtures";
const resources = ["workflows", "connectors", "knowledge-sources", "skills", "files"] as const;

beforeAll(async () => {
  ctx = await createHttpTestServer("catalog_origin_filter");
  for (const [label, description_source, description] of [
    ["generated-a", "llm", "Generated description"],
    ["generated-b", "llm", "Another description"],
    ["human", "human", "Reviewed description"],
    ["pending", "llm", null],
  ] as const) {
    const metadata = { tenant_id: ctx.tenantId, category, description_source, description };
    await ctx.db
      .insert(workflows)
      .values({ ...metadata, slug: label, name: label, lifecycle: "active" });
    await ctx.db.insert(connectors).values({
      ...metadata,
      slug: label,
      display_name: label,
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: "https://example.test",
    });
    await ctx.db.insert(knowledgeSources).values({
      ...metadata,
      slug: label,
      name: label,
      source_type: "inline",
      source_uri: `inline://${label}`,
      version: "fixture",
    });
    await ctx.db.insert(skills).values({
      ...metadata,
      title: label,
      body: "Fixture guidance",
      scope: "global",
      lifecycle: "draft",
    });
    await ctx.db.insert(files).values({
      ...metadata,
      filename: `${label}.txt`,
      storage_uri: `s3://fixture/${label}`,
      status: "ready",
    });
  }
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
});

async function get(path: string) {
  const response = await fetch(`${ctx.baseUrl}${path}`, {
    headers: { authorization: `Bearer ${ctx.apiKey}` },
  });
  expect(response.status).toBe(200);
  return await response.json();
}

for (const resource of resources) {
  test(`${resource} filters real generated descriptions before counting and pagination`, async () => {
    const body = await get(
      `/v1/${resource}?category=${category}&description_source=llm&limit=1&offset=1`,
    );
    expect(body.total).toBe(2);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].description_source).toBe("llm");
    expect(body.items[0].description?.trim().length).toBeGreaterThan(0);
    const human = await get(`/v1/${resource}?category=${category}&description_source=human`);
    expect(human.total).toBe(1);
    expect(human.items[0].description_source).toBe("human");
    const none = await get(`/v1/${resource}?category=absent-origin&description_source=llm`);
    expect(none.total).toBe(0);
    expect(none.items).toEqual([]);
  });
}

test("category origin totals count every object and exclude pending descriptions", async () => {
  const body = await get("/v1/categories");
  const row = body.categories.find((entry: { category: string }) => entry.category === category);
  expect(row).toMatchObject({
    total: 20,
    counts: { workflow: 4, connector: 4, knowledge_source: 4, skill: 4, file: 4 },
    llm_counts: { workflow: 2, connector: 2, knowledge_source: 2, skill: 2, file: 2 },
  });
});
