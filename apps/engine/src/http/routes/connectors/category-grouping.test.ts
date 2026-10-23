import { afterAll, beforeAll, expect, test } from "bun:test";
import { connectors } from "../../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../../tests/setup.ts";

let ctx: HttpTestServer;

beforeAll(async () => {
  ctx = await createHttpTestServer("connector_category_grouping");
  await ctx.db.insert(connectors).values(
    (
      [
        ["zeta-mail", "Zeta Mail", "communication"],
        ["loose", "Loose", "other"],
        ["beta-ai", "beta AI", "ai"],
        ["alpha-ai", "Alpha AI", "ai"],
        ["chat", "Chat", "communication"],
      ] as const
    ).map(([slug, display_name, category]) => ({
      tenant_id: ctx.tenantId,
      slug,
      display_name,
      category,
      driver: "http",
      auth_type: "none" as const,
      environment: "prod" as const,
      base_url: "https://example.test",
    })),
  );
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

async function slugs(query: string) {
  const response = await fetch(`${ctx.baseUrl}/v1/connectors?${query}`, {
    headers: { authorization: `Bearer ${ctx.apiKey}` },
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { items: { slug: string }[] }).items.map((row) => row.slug);
}

test("category grouping keeps each category contiguous and uncategorized last", async () => {
  expect(await slugs("group_by=category&sort=name&order=asc")).toEqual([
    "alpha-ai",
    "beta-ai",
    "chat",
    "zeta-mail",
    "loose",
  ]);
});

test("the chosen sort still orders rows inside each category", async () => {
  expect(await slugs("group_by=category&sort=name&order=desc")).toEqual([
    "beta-ai",
    "alpha-ai",
    "zeta-mail",
    "chat",
    "loose",
  ]);
});

test("category grouping pages continue the same groups", async () => {
  const first = await slugs("group_by=category&sort=name&order=asc&limit=2");
  const second = await slugs("group_by=category&sort=name&order=asc&limit=2&offset=2");
  expect([...first, ...second]).toEqual(["alpha-ai", "beta-ai", "chat", "zeta-mail"]);
});
