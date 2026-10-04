import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { executions } from "../db/schema/executions.ts";
import { tenants } from "../db/schema/identity.ts";
import { workflows } from "../db/schema/workflows.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { aggregateExecutions } from "./aggregate-executions.ts";

const skip = process.env.REQUIRES_PG === "0";

let testDb: TestDb;
let tenantId: string;
let otherTenantId: string;
let workflowId: string;

const FROM = new Date("2024-01-01T00:00:00.000Z");
const TO = new Date("2024-01-02T00:00:00.000Z");
const INSIDE_TS = new Date("2024-01-01T12:00:00.000Z");

beforeAll(async () => {
  if (skip) return;

  testDb = await createTestDb("stats-agg-exec");

  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "stats-exec-tenant", display_name: "Stats Exec Tenant" })
    .returning();
  if (!tenant) throw new Error("seed tenant failed");
  tenantId = tenant.id;

  const [otherTenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "stats-exec-other", display_name: "Stats Exec Other" })
    .returning();
  if (!otherTenant) throw new Error("seed other tenant failed");
  otherTenantId = otherTenant.id;

  const [wf] = await testDb.db
    .insert(workflows)
    .values({
      tenant_id: tenantId,
      slug: "stats-exec-wf",
      name: "Stats Exec Workflow",
      lifecycle: "active",
    })
    .returning();
  if (!wf) throw new Error("seed workflow failed");
  workflowId = wf.id;
}, 60_000);

afterAll(async () => {
  if (!skip && testDb?.cleanup) await testDb.cleanup();
}, 30_000);

afterEach(async () => {
  if (skip) return;
  await testDb.db.delete(executions);
}, 30_000);

describe.skipIf(skip)("aggregateExecutions", () => {
  test("empty window → zero totals and no bucket rows", async () => {
    const result = await aggregateExecutions(testDb.db, {
      tenantId,
      bucket: "hour",
      from: FROM,
      to: TO,
      tz: "UTC",
      groupBy: [],
    });

    expect(result.totals.executions.count).toBe(0);
    expect(result.totals.executions.by_status).toEqual({});
    expect(result.totals.duration_ms.total).toBe(0);
    expect(result.totals.duration_ms.avg).toBe(0);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.buckets).toHaveLength(0);
  });

  test("two executions → total count 2 and by_status exact", async () => {
    await testDb.db.insert(executions).values([
      {
        tenant_id: tenantId,
        workflow_id: workflowId,
        status: "succeeded",
        request_source: "api",
        execution_mode: "prod",
        started_at: INSIDE_TS,
        finished_at: new Date(INSIDE_TS.getTime() + 500),
      },
      {
        tenant_id: tenantId,
        workflow_id: workflowId,
        status: "failed",
        request_source: "api",
        execution_mode: "prod",
        started_at: INSIDE_TS,
        finished_at: new Date(INSIDE_TS.getTime() + 200),
      },
    ]);

    const result = await aggregateExecutions(testDb.db, {
      tenantId,
      bucket: "hour",
      from: FROM,
      to: TO,
      tz: "UTC",
      groupBy: [],
    });

    expect(result.totals.executions.count).toBe(2);
    expect(result.totals.executions.by_status).toEqual({ succeeded: 1, failed: 1 });
    expect(result.totals.duration_ms.total).toBeGreaterThan(0);
  });

  test("group_by status produces per-status group keys", async () => {
    await testDb.db.insert(executions).values([
      {
        tenant_id: tenantId,
        workflow_id: workflowId,
        status: "succeeded",
        request_source: "api",
        execution_mode: "prod",
        started_at: INSIDE_TS,
      },
      {
        tenant_id: tenantId,
        workflow_id: workflowId,
        status: "failed",
        request_source: "api",
        execution_mode: "prod",
        started_at: INSIDE_TS,
      },
      {
        tenant_id: tenantId,
        workflow_id: workflowId,
        status: "succeeded",
        request_source: "api",
        execution_mode: "prod",
        started_at: INSIDE_TS,
      },
    ]);

    const result = await aggregateExecutions(testDb.db, {
      tenantId,
      bucket: "hour",
      from: FROM,
      to: TO,
      tz: "UTC",
      groupBy: ["status"],
    });

    expect(result.groups).toHaveLength(2);
    const groupKeys = result.groups.map((g) => g.key.status).sort();
    expect(groupKeys).toEqual(["failed", "succeeded"]);

    const succeededGroup = result.groups.find((g) => g.key.status === "succeeded")!;
    expect(succeededGroup.totals.executions).toBe(2);

    const failedGroup = result.groups.find((g) => g.key.status === "failed")!;
    expect(failedGroup.totals.executions).toBe(1);
  });

  test("group_by workflow_id gives workflow-keyed groups", async () => {
    const [wf2] = await testDb.db
      .insert(workflows)
      .values({
        tenant_id: tenantId,
        slug: "stats-exec-wf2",
        name: "Stats Exec Workflow 2",
        lifecycle: "active",
      })
      .returning();
    if (!wf2) throw new Error("seed wf2 failed");

    await testDb.db.insert(executions).values([
      {
        tenant_id: tenantId,
        workflow_id: workflowId,
        status: "succeeded",
        request_source: "api",
        execution_mode: "prod",
        started_at: INSIDE_TS,
      },
      {
        tenant_id: tenantId,
        workflow_id: wf2.id,
        status: "succeeded",
        request_source: "api",
        execution_mode: "prod",
        started_at: INSIDE_TS,
      },
    ]);

    const result = await aggregateExecutions(testDb.db, {
      tenantId,
      bucket: "hour",
      from: FROM,
      to: TO,
      tz: "UTC",
      groupBy: ["workflow_id"],
    });

    expect(result.groups).toHaveLength(2);
    const ids = result.groups.map((g) => g.key.workflow_id).sort();
    expect(ids).toContain(workflowId);
    expect(ids).toContain(wf2.id);
  });

  test("tenant isolation — wrong tenant returns zero", async () => {
    await testDb.db.insert(executions).values({
      tenant_id: tenantId,
      workflow_id: workflowId,
      status: "succeeded",
      request_source: "api",
      execution_mode: "prod",
      started_at: INSIDE_TS,
    });

    const result = await aggregateExecutions(testDb.db, {
      tenantId: otherTenantId,
      bucket: "hour",
      from: FROM,
      to: TO,
      tz: "UTC",
      groupBy: [],
    });

    expect(result.totals.executions.count).toBe(0);
    expect(result.groups[0]!.totals.executions).toBe(0);
    expect(result.groups[0]!.buckets).toHaveLength(0);
  });

  test("by_status is exact — no phantom statuses", async () => {
    await testDb.db.insert(executions).values([
      {
        tenant_id: tenantId,
        workflow_id: workflowId,
        status: "succeeded",
        request_source: "api",
        execution_mode: "prod",
        started_at: INSIDE_TS,
      },
      {
        tenant_id: tenantId,
        workflow_id: workflowId,
        status: "succeeded",
        request_source: "api",
        execution_mode: "prod",
        started_at: INSIDE_TS,
      },
      {
        tenant_id: tenantId,
        workflow_id: workflowId,
        status: "aborted",
        request_source: "api",
        execution_mode: "prod",
        started_at: INSIDE_TS,
      },
    ]);

    const result = await aggregateExecutions(testDb.db, {
      tenantId,
      bucket: "hour",
      from: FROM,
      to: TO,
      tz: "UTC",
      groupBy: [],
    });

    expect(result.totals.executions.by_status).toEqual({ succeeded: 2, aborted: 1 });
    expect(Object.keys(result.totals.executions.by_status).length).toBe(2);
  });

  test("percentiles are computed and non-negative", async () => {
    const durations = [100, 200, 300];
    for (const dur of durations) {
      await testDb.db.insert(executions).values({
        tenant_id: tenantId,
        workflow_id: workflowId,
        status: "succeeded",
        request_source: "api",
        execution_mode: "prod",
        started_at: INSIDE_TS,
        finished_at: new Date(INSIDE_TS.getTime() + dur),
      });
    }

    const result = await aggregateExecutions(testDb.db, {
      tenantId,
      bucket: "hour",
      from: FROM,
      to: TO,
      tz: "UTC",
      groupBy: [],
    });

    const dur = result.totals.duration_ms;
    expect(dur.p50).toBeGreaterThan(0);
    expect(dur.p95).toBeGreaterThanOrEqual(dur.p50);
    expect(dur.p99).toBeGreaterThanOrEqual(dur.p95);
    expect(dur.max).toBeGreaterThanOrEqual(dur.p99);
  });
});
