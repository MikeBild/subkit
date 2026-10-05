import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tenants, workflows } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import { listWorkflowSummaries, listWorkflows } from "../service.ts";

let ctx: TestDb;
let tenantA = "";
let tenantB = "";

beforeAll(async () => {
  ctx = await createTestDb("workflows_list_total");
  const [a] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-list-total-a", display_name: "A" })
    .returning();
  const [b] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-list-total-b", display_name: "B" })
    .returning();
  tenantA = a!.id;
  tenantB = b!.id;

  const rows = Array.from({ length: 25 }, (_, i) => ({
    tenant_id: tenantA,
    slug: `wf-${String(i).padStart(2, "0")}`,
    name: `Workflow ${i}`,
    lifecycle: i < 20 ? ("active" as const) : ("archived" as const),
  }));
  await ctx.db.insert(workflows).values(rows);
  await ctx.db.insert(workflows).values({
    tenant_id: tenantA,
    slug: "wf-deleted",
    name: "Gone",
    lifecycle: "active",
    deleted_at: new Date(FROZEN_NOW),
  });

  await ctx.db.insert(workflows).values([
    { tenant_id: tenantB, slug: "b-1", name: "B1", lifecycle: "active" },
    { tenant_id: tenantB, slug: "b-2", name: "B2", lifecycle: "active" },
  ]);
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("listWorkflows — { rows, total } contract", () => {
  test("default call enumerates the complete catalog with exact total", async () => {
    const { rows, total } = await listWorkflows(tenantA, {}, ctx.db);
    expect(total).toBe(25);
    expect(rows).toHaveLength(25);
    expect(rows.map((r) => r.slug)).not.toContain("wf-deleted");
  });

  test("a capped page still reports the full filtered total", async () => {
    const { rows, total } = await listWorkflows(tenantA, { limit: 10 }, ctx.db);
    expect(rows).toHaveLength(10);
    expect(total).toBe(25);
  });

  test("total respects the same filters as the page (status)", async () => {
    const archived = await listWorkflows(tenantA, { status: "archived" }, ctx.db);
    expect(archived.total).toBe(5);
    expect(archived.rows).toHaveLength(5);

    const activePage = await listWorkflows(tenantA, { status: "active", limit: 3 }, ctx.db);
    expect(activePage.rows).toHaveLength(3);
    expect(activePage.total).toBe(20);
  });

  test("total respects name_contains", async () => {
    const { rows, total } = await listWorkflows(
      tenantA,
      { name_contains: "Workflow 1", limit: 2 },
      ctx.db,
    );
    expect(total).toBe(11);
    expect(rows).toHaveLength(2);
  });

  test("paging past the end still reports the true total (not 0)", async () => {
    const { rows, total } = await listWorkflows(tenantA, { limit: 10, offset: 100 }, ctx.db);
    expect(rows).toHaveLength(0);
    expect(total).toBe(25);
  });

  test("empty tenant scope yields total 0", async () => {
    const { rows, total } = await listWorkflows(tenantB, { status: "archived" }, ctx.db);
    expect(rows).toHaveLength(0);
    expect(total).toBe(0);
  });

  test("tenant isolation — tenant B sees only its own total", async () => {
    const { rows, total } = await listWorkflows(tenantB, {}, ctx.db);
    expect(total).toBe(2);
    expect(rows.map((r) => r.slug).sort()).toEqual(["b-1", "b-2"]);
  });
});

describe("listWorkflowSummaries — same contract, same numbers", () => {
  test("summaries agree with listWorkflows on totals", async () => {
    const all = await listWorkflowSummaries(tenantA, {}, ctx.db);
    expect(all.total).toBe(25);
    expect(all.rows).toHaveLength(25);

    const page = await listWorkflowSummaries(tenantA, { status: "active", limit: 4 }, ctx.db);
    expect(page.rows).toHaveLength(4);
    expect(page.total).toBe(20);
  });
});

describe("listWorkflows — sorted by name", () => {
  test("names sort without regard to case, also across a page boundary", async () => {
    const [tenant] = await ctx.db
      .insert(tenants)
      .values({ slug: "t-list-name-case", display_name: "C" })
      .returning();
    await ctx.db.insert(workflows).values(
      ["cherry", "Banana", "apple"].map((name) => ({
        tenant_id: tenant!.id,
        slug: name.toLowerCase(),
        name,
        lifecycle: "active" as const,
      })),
    );
    const all = await listWorkflows(tenant!.id, { sort: "name", order: "asc" }, ctx.db);
    expect(all.rows.map((row) => row.name)).toEqual(["apple", "Banana", "cherry"]);
    const second = await listWorkflows(
      tenant!.id,
      { sort: "name", order: "asc", limit: 1, offset: 1 },
      ctx.db,
    );
    expect(second.rows.map((row) => row.name)).toEqual(["Banana"]);
  });
});
