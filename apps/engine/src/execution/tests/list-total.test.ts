import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { executionSteps, executions } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { listExecutions } from "../list.ts";

let ctx: TestDb;
let tenantA = "";
let tenantB = "";

beforeAll(async () => {
  ctx = await createTestDb("executions_list_total");
  const a = await seedTenant(ctx.db, { slug: "t-exec-total-a", display_name: "A" });
  const b = await seedTenant(ctx.db, { slug: "t-exec-total-b", display_name: "B" });
  tenantA = a.id;
  tenantB = b.id;

  await ctx.db.insert(executions).values(
    Array.from({ length: 12 }, (_, i) => ({
      tenant_id: tenantA,
      status: (i < 9 ? "succeeded" : "failed") as "succeeded" | "failed",
      request_source: i < 9 ? "api" : "scheduler",
      execution_mode: "dev" as const,
      source_kind: "saved",
    })),
  );
  await ctx.db.insert(executions).values({
    tenant_id: tenantB,
    status: "succeeded",
    request_source: "api",
    execution_mode: "dev",
    source_kind: "saved",
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("listExecutions — { rows, total } contract", () => {
  test("a page reports the exact tenant-wide total", async () => {
    const { rows, total } = await listExecutions(tenantA, { limit: 10 }, ctx.db);
    expect(rows).toHaveLength(10);
    expect(total).toBe(12);
  });

  test("total respects status + request_source filters", async () => {
    const failed = await listExecutions(tenantA, { status: "failed" }, ctx.db);
    expect(failed.total).toBe(3);
    expect(failed.rows).toHaveLength(3);

    const scheduler = await listExecutions(
      tenantA,
      { request_source: "scheduler", limit: 1 },
      ctx.db,
    );
    expect(scheduler.rows).toHaveLength(1);
    expect(scheduler.total).toBe(3);
  });

  test("several statuses separated by commas count every run in any of them", async () => {
    const both = await listExecutions(tenantA, { status: "succeeded, failed", limit: 1 }, ctx.db);
    expect(both.rows).toHaveLength(1);
    expect(both.total).toBe(12);

    const failing = await listExecutions(
      tenantA,
      { status: "failed,timed_out,aborted", limit: 1 },
      ctx.db,
    );
    expect(failing.total).toBe(3);
  });

  test("a later page keeps the true total", async () => {
    const first = await listExecutions(tenantA, { limit: 5 }, ctx.db);
    expect(first.next_cursor).not.toBeNull();
    const second = await listExecutions(
      tenantA,
      { limit: 5, cursor: first.next_cursor ?? "" },
      ctx.db,
    );
    expect(second.rows).toHaveLength(5);
    expect(second.total).toBe(12);
  });

  test("tenant isolation", async () => {
    const { rows, total } = await listExecutions(tenantB, {}, ctx.db);
    expect(total).toBe(1);
    expect(rows).toHaveLength(1);
  });

  test("held_effects filters by canonical and legacy held step evidence", async () => {
    const [canonical] = await ctx.db
      .insert(executions)
      .values({
        tenant_id: tenantA,
        status: "succeeded",
        request_source: "api",
        execution_mode: "dev",
        source_kind: "saved",
      })
      .returning();
    const [legacy] = await ctx.db
      .insert(executions)
      .values({
        tenant_id: tenantA,
        status: "succeeded",
        request_source: "api",
        execution_mode: "dev",
        source_kind: "saved",
      })
      .returning();
    const [otherTenant] = await ctx.db
      .insert(executions)
      .values({
        tenant_id: tenantB,
        status: "succeeded",
        request_source: "api",
        execution_mode: "dev",
        source_kind: "saved",
      })
      .returning();
    await ctx.db.insert(executionSteps).values([
      {
        tenant_id: tenantA,
        execution_id: canonical!.id,
        step_key: "canonical",
        kind: "request",
        status: "succeeded",
        held: true,
      },
      {
        tenant_id: tenantA,
        execution_id: legacy!.id,
        step_key: "legacy",
        kind: "request",
        status: "succeeded",
        request_meta: { extras: { held: true } },
      },
      {
        tenant_id: tenantB,
        execution_id: otherTenant!.id,
        step_key: "other-tenant",
        kind: "request",
        status: "succeeded",
        held: true,
      },
    ]);

    const held = await listExecutions(tenantA, { held_effects: true, limit: 20 }, ctx.db);
    expect(held.total).toBe(2);
    expect(held.rows.map((row) => row.id).sort()).toEqual([canonical!.id, legacy!.id].sort());

    const notHeld = await listExecutions(tenantA, { held_effects: false, limit: 20 }, ctx.db);
    expect(notHeld.total).toBe(12);
    expect(notHeld.rows.some((row) => row.id === canonical!.id || row.id === legacy!.id)).toBe(
      false,
    );
  });
});
