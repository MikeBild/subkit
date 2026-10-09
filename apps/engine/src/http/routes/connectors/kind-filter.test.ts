import { afterAll, beforeAll, expect, test } from "bun:test";
import { connectors } from "../../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../../tests/setup.ts";

let ctx: HttpTestServer;

beforeAll(async () => {
  ctx = await createHttpTestServer("connector_kind_filter");
  await ctx.db.insert(connectors).values(
    (
      [
        ["mcp-oauth", "mcp", "oauth2"],
        ["mcp-key", "mcp", "bearer"],
        ["oauth", "http", "oauth2"],
        ["key-a", "http", "bearer"],
        ["key-b", "http", "header"],
        ["public", "http", "none"],
      ] as const
    ).map(([slug, driver, auth_type]) => ({
      tenant_id: ctx.tenantId,
      slug,
      display_name: slug,
      driver,
      auth_type,
      environment: "prod" as const,
      base_url: "https://example.test",
    })),
  );
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

async function list(query: string) {
  const response = await fetch(`${ctx.baseUrl}/v1/connectors?${query}`, {
    headers: { authorization: `Bearer ${ctx.apiKey}` },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { items: { slug: string }[]; total: number };
}

test("MCP has precedence over its authentication mode and public connectors are not keys", async () => {
  for (const [kind, expected] of [
    ["mcp", ["mcp-key", "mcp-oauth"]],
    ["oauth", ["oauth"]],
    ["key", ["key-a", "key-b"]],
  ] as const) {
    const body = await list(`kind=${kind}&sort=name&order=asc`);
    expect(body.items.map((row) => row.slug)).toEqual([...expected]);
    expect(body.total).toBe(expected.length);
  }
});

test("kind narrows count before pagination and intersects other filters", async () => {
  const page = await list("kind=key&sort=name&order=asc&limit=1&offset=1");
  expect(page.total).toBe(2);
  expect(page.items.map((row) => row.slug)).toEqual(["key-b"]);
  const incompatible = await list("kind=key&driver=mcp");
  expect(incompatible.total).toBe(0);
  expect(incompatible.items).toEqual([]);
});
