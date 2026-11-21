import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { executions, tenants, workflows } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { aggregateExecutions } from "../../stats/index.ts";
import { listExecutions } from "../list.ts";

let ctx: TestDb;
let tenant = "";
let other = "";
const NOW = Date.parse("2026-08-10T12:00:00.000Z");
const hoursAgo = (hours: number) => new Date(NOW - hours * 3_600_000);
const FROM = hoursAgo(7 * 24);
const TO = new Date(NOW);

beforeAll(async () => {
  ctx = await createTestDb("executions_list_window");
  const [a] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-exec-win-a", display_name: "A" })
    .returning();
  const [b] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-exec-win-b", display_name: "B" })
    .returning();
  tenant = a!.id;
  other = b!.id;
  const [wf] = await ctx.db
    .insert(workflows)
    .values({ tenant_id: tenant, slug: "bericht", name: "Bericht", lifecycle: "active" })
    .returning();
  const run = (
    tenant_id: string,
    status: "succeeded" | "failed" | "queued",
    started: Date | null,
  ) => ({
    tenant_id,
    workflow_id: tenant_id === tenant ? wf!.id : null,
    status,
    execution_mode: "prod" as const,
    source_kind: "saved",
    request_source: "scheduler",
    started_at: started,
    finished_at: started ? new Date(started.getTime() + 1000) : null,
  });
  await ctx.db
    .insert(executions)
    .values([
      run(tenant, "succeeded", hoursAgo(1)),
      run(tenant, "succeeded", hoursAgo(30)),
      run(tenant, "succeeded", FROM),
      run(tenant, "failed", hoursAgo(2)),
      run(tenant, "failed", hoursAgo(100)),
      run(tenant, "failed", hoursAgo(8 * 24)),
      run(tenant, "succeeded", TO),
      run(tenant, "queued", null),
      run(other, "failed", hoursAgo(3)),
    ]);
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("a window on the run log", () => {
  test("the list holds exactly the runs the stats count over the same bounds", async () => {
    const stats = await aggregateExecutions(ctx.db, {
      tenantId: tenant,
      bucket: "day",
      from: FROM,
      to: TO,
      tz: "UTC",
      groupBy: [],
    });
    const all = await listExecutions(tenant, { started_from: FROM, started_to: TO }, ctx.db);
    expect(all.total).toBe(5);
    expect(all.total).toBe(stats.totals.executions.count);

    const failed = await listExecutions(
      tenant,
      { started_from: FROM, started_to: TO, status: "failed" },
      ctx.db,
    );
    expect(failed.total).toBe(2);
    expect(failed.total).toBe(stats.totals.executions.by_status.failed ?? 0);
  });

  test("each bound works alone, and no bound is the whole log", async () => {
    expect((await listExecutions(tenant, { started_from: FROM }, ctx.db)).total).toBe(6);
    expect((await listExecutions(tenant, { started_to: FROM }, ctx.db)).total).toBe(1);
    expect((await listExecutions(tenant, {}, ctx.db)).total).toBe(8);
  });
});
