// Searching the run log by the name of the thing that ran.
//
// A run has no name of its own, so `q` reaches through `workflow_id` into the
// workflow. Two properties matter and both are pinned here: the needle finds
// runs beyond the first page, which is the whole reason the parameter exists;
// and it never reaches across tenants, which is the way a search like this
// goes wrong — the subquery that resolves the name is scoped separately from
// the one that lists the runs, so a missing predicate there would be invisible
// in the run list's own tenant filter.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { executions, tenants, workflows } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { listExecutions } from "../list.ts";

let ctx: TestDb;
let tenantA = "";
let tenantB = "";
let reportWorkflow = "";
let invoiceWorkflow = "";

beforeAll(async () => {
  ctx = await createTestDb("executions_list_search");
  const [a] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-exec-q-a", display_name: "A" })
    .returning();
  const [b] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-exec-q-b", display_name: "B" })
    .returning();
  tenantA = a!.id;
  tenantB = b!.id;

  const [report] = await ctx.db
    .insert(workflows)
    .values({
      tenant_id: tenantA,
      slug: "monatsreport",
      name: "Monatsreport",
      lifecycle: "active",
    })
    .returning();
  const [invoice] = await ctx.db
    .insert(workflows)
    .values({
      tenant_id: tenantA,
      slug: "rechnungslauf",
      name: "Rechnungslauf",
      lifecycle: "active",
    })
    .returning();
  reportWorkflow = report!.id;
  invoiceWorkflow = invoice!.id;

  // The other tenant runs a workflow whose name contains the same needle.
  const [foreign] = await ctx.db
    .insert(workflows)
    .values({
      tenant_id: tenantB,
      slug: "monatsreport-fremd",
      name: "Monatsreport (fremd)",
      lifecycle: "active",
    })
    .returning();

  // 60 invoice runs sit in front of the 3 report runs, so a needle that only
  // narrowed the first page of 50 would find none of them.
  await ctx.db.insert(executions).values([
    ...Array.from({ length: 3 }, () => ({
      tenant_id: tenantA,
      workflow_id: reportWorkflow,
      status: "succeeded" as const,
      execution_mode: "dev" as const,
      source_kind: "saved",
      request_source: "api",
    })),
    ...Array.from({ length: 60 }, () => ({
      tenant_id: tenantA,
      workflow_id: invoiceWorkflow,
      status: "succeeded" as const,
      execution_mode: "dev" as const,
      source_kind: "saved",
      request_source: "api",
    })),
    {
      tenant_id: tenantB,
      workflow_id: foreign!.id,
      status: "succeeded" as const,
      execution_mode: "dev" as const,
      source_kind: "saved",
      request_source: "api",
    },
  ]);
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

describe("listExecutions with a needle", () => {
  test("finds runs by the workflow's name, past the first page", async () => {
    const { rows, total } = await listExecutions(tenantA, { q: "Monatsreport" }, ctx.db);
    expect(total).toBe(3);
    expect(rows.every((row) => row.workflow_id === reportWorkflow)).toBe(true);
  });

  test("matches the slug as well as the name", async () => {
    const { total } = await listExecutions(tenantA, { q: "rechnungslauf" }, ctx.db);
    expect(total).toBe(60);
  });

  test("is case-insensitive and matches a fragment", async () => {
    const { total } = await listExecutions(tenantA, { q: "monatsrep" }, ctx.db);
    expect(total).toBe(3);
  });

  test("never reaches into another tenant's runs", async () => {
    const { rows, total } = await listExecutions(tenantB, { q: "Monatsreport" }, ctx.db);
    expect(total).toBe(1);
    expect(rows.every((row) => row.tenant_id === tenantB)).toBe(true);
  });

  test("a needle nothing answers returns nothing, not everything", async () => {
    const { rows, total } = await listExecutions(tenantA, { q: "gibtesnicht" }, ctx.db);
    expect(total).toBe(0);
    expect(rows).toHaveLength(0);
  });

  test("no needle still lists the whole log", async () => {
    const { total } = await listExecutions(tenantA, {}, ctx.db);
    expect(total).toBe(63);
  });

  test("blank whitespace is not a needle", async () => {
    const { total } = await listExecutions(tenantA, { q: "   " }, ctx.db);
    expect(total).toBe(63);
  });
});
