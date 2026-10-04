import { afterAll, beforeAll, expect, test } from "bun:test";
import { tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { loadTenantSummary, renderTenantSummaryBlock } from "../../llm/core/tenant-summary.ts";
import { seedMcpConnector } from "../../mcp/client/test-fixtures.ts";
import { categoryOfConnector } from "../categorize.ts";
import { listConnectors } from "../service.ts";

let ctx: TestDb;
let tenant_id: string;
let mcpConnectorId: string;

beforeAll(async () => {
  ctx = await createTestDb("mcp-connector-catalog");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "mcp-catalog-t", display_name: "MCP Catalog" })
    .returning();
  if (!t) throw new Error("tenant seed failed");
  tenant_id = t.id;

  const seeded = await seedMcpConnector(ctx.db, {
    tenant_id,
    slug: "rovo",
    display_name: "Atlassian Rovo",
    url: "https://rovo.example.test/mcp",
  });
  mcpConnectorId = seeded.id;
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

test("listConnectors returns the mcp connector, blocked under its driver", async () => {
  const { rows } = await listConnectors(tenant_id, {}, ctx.db);
  const found = rows.find((r) => r.id === mcpConnectorId);
  expect(found).toBeDefined();
  expect(found?.driver).toBe("mcp");
  expect(categoryOfConnector(found!)).toBe("mcp");
});

test("a category filter of 'mcp' selects it, exactly as 'http' selects an http connector", async () => {
  const { rows } = await listConnectors(tenant_id, { category: "mcp" }, ctx.db);
  expect(rows.map((r) => r.id)).toEqual([mcpConnectorId]);
});

test("the tenant snapshot names it, so the model answers 'what do I have' without a list_ call", async () => {
  const summary = await loadTenantSummary(tenant_id, ctx.db);
  expect(summary.connectors.map((c) => c.id)).toContain(mcpConnectorId);
  const block = renderTenantSummaryBlock(summary);
  expect(block ?? "").toContain(`rovo (mcp/prod)`);
  expect(block ?? "").toContain(mcpConnectorId);
});
