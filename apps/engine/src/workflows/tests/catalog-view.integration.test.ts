import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connectors, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { serializeOne } from "../../http/routes/workflow-representation.ts";
import { buildNamingGroundingBlock, loadCategoryIndex } from "../catalog-view.ts";
import { UNCATEGORIZED } from "../categorize.ts";
import { listConnectorRefs, listWorkflowsUsingConnector } from "../connector-refs.ts";
import { createWorkflow, getWorkflow, listWorkflows } from "../service.ts";

let ctx: TestDb;
let tenant_id = "";
let apiConnectorId = "";

async function seedConnector(slug: string): Promise<string> {
  const [row] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id,
      slug,
      display_name: slug,
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: "https://api.example.test",
      config: {},
    })
    .returning();
  if (!row) throw new Error(`seed connector ${slug} failed`);
  return row.id;
}

async function seedWorkflow(slug: string, step: Record<string, unknown>): Promise<string> {
  const result = await createWorkflow(
    {
      tenant_id,
      actor_id: null,
      def: { name: slug, slug, steps: [step] },
    },
    ctx.db,
  );
  if (!result.workflow) throw new Error(`seed ${slug} failed: ${JSON.stringify(result.errors)}`);
  return result.workflow.id;
}

beforeAll(async () => {
  ctx = await createTestDb("workflows_catalog_view");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-catalog-view", display_name: "Catalog" })
    .returning();
  tenant_id = t!.id;

  apiConnectorId = await seedConnector("billing-api");
  await seedConnector("unused-api");

  for (const name of ["search-pages", "append-markdown", "page-properties"]) {
    await seedWorkflow(`notion-${name}`, {
      id: "s1",
      kind: "request",
      method: "GET",
      url: "https://notion.example.test/x",
    });
  }
  for (const name of ["by-date", "tomorrow"]) {
    await seedWorkflow(`berlin-weather-${name}`, {
      id: "s1",
      kind: "request",
      method: "GET",
      url: "https://weather.example.test/x",
    });
  }

  await seedWorkflow("billing-by-id", {
    id: "s1",
    kind: "request",
    connector_id: apiConnectorId,
    method: "GET",
    path: "/invoices",
  });
  await seedWorkflow("billing-by-placeholder", {
    id: "s1",
    kind: "request",
    method: "GET",
    url: "${connector.billing-api.base_url}/invoices",
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("category derivation over a live catalog", () => {
  test("a family of three becomes a block, a pair does not", async () => {
    const index = await loadCategoryIndex(tenant_id, ctx.db);
    expect(index.get("notion-search-pages")).toBe("notion");
    expect(index.get("berlin-weather-by-date")).toBe(UNCATEGORIZED);
  });

  test("one workflow read on its own names the same block the list does", async () => {
    const { rows } = await listWorkflows(tenant_id, {}, ctx.db);
    const index = await loadCategoryIndex(tenant_id, ctx.db);
    for (const slug of ["notion-search-pages", "berlin-weather-by-date"]) {
      const row = rows.find((r) => r.slug === slug);
      const workflow = row ? await getWorkflow(tenant_id, row.id, ctx.db) : null;
      if (!workflow) throw new Error(`missing ${slug}`);
      const detail = await serializeOne(workflow, tenant_id, ctx.db);
      expect(detail.category).toBe(index.get(slug) ?? UNCATEGORIZED);
    }
    const notion = rows.find((r) => r.slug === "notion-search-pages");
    const read = notion ? await getWorkflow(tenant_id, notion.id, ctx.db) : null;
    expect(read ? (await serializeOne(read, tenant_id, ctx.db)).category : null).toBe("notion");
  });

  test("filtering by category returns that block and totals only matches", async () => {
    const { rows, total } = await listWorkflows(tenant_id, { category: "notion" }, ctx.db);
    expect(total).toBe(3);
    expect(rows.map((r) => r.slug).sort()).toEqual([
      "notion-append-markdown",
      "notion-page-properties",
      "notion-search-pages",
    ]);
  });

  test("an unknown category matches nothing rather than everything", async () => {
    const { rows, total } = await listWorkflows(tenant_id, { category: "nope" }, ctx.db);
    expect(total).toBe(0);
    expect(rows).toHaveLength(0);
  });
});

describe("naming grounding", () => {
  test("names the real families so a new draft can join one", async () => {
    const block = await buildNamingGroundingBlock(tenant_id, ctx.db);
    expect(block).toContain("notion (3)");
    expect(block).toContain("slug");
    expect(block).toContain("name");
  });

  test("never advertises the catch-all as a family to join", async () => {
    const block = await buildNamingGroundingBlock(tenant_id, ctx.db);
    expect(block).not.toContain(`${UNCATEGORIZED} (`);
  });

  test("returns nothing for a catalog with no families yet", async () => {
    const [fresh] = await ctx.db
      .insert(tenants)
      .values({ slug: "t-catalog-view-fresh", display_name: "Fresh" })
      .returning();
    expect(await buildNamingGroundingBlock(fresh!.id, ctx.db)).toBeNull();
  });
});

describe("connector references", () => {
  test("reports both binding forms as usage", async () => {
    const refs = await listConnectorRefs(tenant_id, ctx.db);
    const all = [...refs.values()].flat();
    expect(all.filter((s) => s === "billing-api")).toHaveLength(2);
    expect(all).not.toContain("unused-api");
  });

  test("filters workflows by connector across both binding forms", async () => {
    const { rows, total } = await listWorkflows(tenant_id, { connector: "billing-api" }, ctx.db);
    expect(total).toBe(2);
    expect(rows.map((r) => r.slug).sort()).toEqual(["billing-by-id", "billing-by-placeholder"]);
  });

  test("accepts the connector id as well as the slug", async () => {
    const { rows } = await listWorkflows(tenant_id, { connector: apiConnectorId }, ctx.db);
    expect(rows.map((r) => r.slug).sort()).toEqual(["billing-by-id", "billing-by-placeholder"]);
  });

  test("the delete guard sees the placeholder-only dependant", async () => {
    const deps = await listWorkflowsUsingConnector(tenant_id, apiConnectorId, ctx.db);
    expect(deps.map((d) => d.slug).sort()).toEqual(["billing-by-id", "billing-by-placeholder"]);
  });

  test("an unreferenced connector has no dependants", async () => {
    const { total } = await listWorkflows(tenant_id, { connector: "unused-api" }, ctx.db);
    expect(total).toBe(0);
  });

  test("an unknown connector matches nothing rather than everything", async () => {
    const { total } = await listWorkflows(tenant_id, { connector: "does-not-exist" }, ctx.db);
    expect(total).toBe(0);
  });

  test("category and connector compose", async () => {
    const { total } = await listWorkflows(
      tenant_id,
      { category: "notion", connector: "billing-api" },
      ctx.db,
    );
    expect(total).toBe(0);
  });
});
