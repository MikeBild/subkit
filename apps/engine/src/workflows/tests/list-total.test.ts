// Ground-truth cardinality for the workflow list services (Fix 3,
// sessions 2026-06-11/12). `listWorkflows` / `listWorkflowSummaries`
// return `{ rows, total }` where `total` is the EXACT tenant-scoped
// count under the same WHERE filters (status, name_contains) ignoring
// limit/offset — computed via `count(*) over ()` in the same query.
//
// Regression target: the fast path rendered "10 workflows:" while the
// tenant had 20; any consumer of a capped page could only present the
// page as the universe.

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

  // Tenant A: 25 workflows — 20 active, 5 archived, 1 of the active
  // ones soft-deleted (must not count anywhere).
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

  // Tenant B: 2 workflows — isolation guard.
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
    // "Workflow 1" + "Workflow 10".."Workflow 19" = 11 matches.
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
