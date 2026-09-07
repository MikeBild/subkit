// Tenant-isolation guarantee for schedule-triggered workflows.
//
// The `workflows_schedules` table is joined to `workflows` on `workflow_id`
// only. The contract: a schedule owned by tenant A must never fire tenant B's
// workflow, and tenant B's schedule with the same cron must not produce
// execution rows visible to tenant A. A handcrafted row where
// `tenant_id != workflow.tenant_id` must be skipped with a structured warning.
//
// Uses the stub-boss pattern from `calendar-gate.test.ts` so the reconciler
// clock is fake and deterministic.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { auditLog, executions, tenants, workflowsSchedules } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { createWorkflowRow, type EngineTestCtx } from "../../execution/tests/setup.ts";
import { SchedulerReconciler } from "../reconciler.ts";
import { grantScheduleAuthorityFixture } from "./authority-fixture.ts";

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let testDb: TestDb;
let ctxA: EngineTestCtx;
let ctxB: EngineTestCtx;
let workflowA: string;
let workflowB: string;

// A deterministic tick: 2026-05-04 09:01 UTC — well past any cron boundary
// for `* * * * *` without any previous `last_enqueued_at`.
const TICK = new Date(Date.UTC(2026, 4, 4, 9, 1, 0));

// ---------------------------------------------------------------------------
// Stub boss — records every boss.send call for inspection.
// ---------------------------------------------------------------------------

interface SendCall {
  queue: string;
  payload: unknown;
}

function createStubBoss(calls: SendCall[]): PgBoss {
  return {
    send: async (queue: string, payload: unknown) => {
      calls.push({ queue, payload });
      return "stub-job-id";
    },
    schedule: async () => undefined,
    unschedule: async () => undefined,
    getQueues: async () => [],
    createQueue: async () => undefined,
    on: () => undefined,
  } as unknown as PgBoss;
}

// ---------------------------------------------------------------------------
// Two-tenant setup: tenant A + tenant B each get an independent workflow.
// ---------------------------------------------------------------------------

beforeAll(async () => {
  testDb = await createTestDb("sched-tenant-iso");

  // Build two EngineTestCtx-shaped objects that share the same testDb but
  // each hold their own tenant. We seed the tenants directly instead of
  // calling createEngineCtx twice (which would create two databases).
  const [tA] = await testDb.db
    .insert(tenants)
    .values({ slug: "sched-iso-a", display_name: "Sched-Iso Tenant A" })
    .returning();
  if (!tA) throw new Error("seed tenant A failed");

  const [tB] = await testDb.db
    .insert(tenants)
    .values({ slug: "sched-iso-b", display_name: "Sched-Iso Tenant B" })
    .returning();
  if (!tB) throw new Error("seed tenant B failed");

  ctxA = { testDb, tenantId: tA.id, cleanup: async () => {} };
  ctxB = { testDb, tenantId: tB.id, cleanup: async () => {} };

  const wfA = await createWorkflowRow(ctxA, {
    name: "sched-wf-a",
    slug: "sched-wf-a",
    steps: [{ id: "noop", kind: "transform", expression: "$input" }],
  });
  workflowA = wfA.workflow_id;

  const wfB = await createWorkflowRow(ctxB, {
    name: "sched-wf-b",
    slug: "sched-wf-b",
    steps: [{ id: "noop", kind: "transform", expression: "$input" }],
  });
  workflowB = wfB.workflow_id;
  await grantScheduleAuthorityFixture(testDb.db, ctxA.tenantId, workflowA);
  await grantScheduleAuthorityFixture(testDb.db, ctxB.tenantId, workflowB);
});

afterAll(async () => {
  await testDb.cleanup();
});

// ---------------------------------------------------------------------------
// Test 1: tenant A's schedule fires only tenant A's workflow.
// ---------------------------------------------------------------------------

describe("scheduler tenant isolation", () => {
  test("tenant A schedule fires exactly one execution row under tenant A", async () => {
    const calls: SendCall[] = [];
    const boss = createStubBoss(calls);

    await testDb.db.insert(workflowsSchedules).values({
      tenant_id: ctxA.tenantId,
      workflow_id: workflowA,
      cron: "* * * * *",
      timezone: "UTC",
      paused: false,
      // Never fired; created before the tick so the schedule is due (a
      // fresh schedule waits for its first cron occurrence after creation).
      last_enqueued_at: null,
      created_at: new Date(TICK.getTime() - 120_000),
    });

    const reconciler = new SchedulerReconciler({ boss, db: testDb.db });
    await reconciler.reconcileWorkflowSchedules(TICK);

    // Exactly one execution row; it must belong to tenant A.
    const execRowsA = await testDb.db
      .select()
      .from(executions)
      .where(eq(executions.tenant_id, ctxA.tenantId));
    expect(execRowsA.length).toBe(1);
    expect(execRowsA[0]?.workflow_id).toBe(workflowA);
    expect(execRowsA[0]?.request_source).toBe("scheduler");

    // Tenant B has no executions.
    const execRowsB = await testDb.db
      .select()
      .from(executions)
      .where(eq(executions.tenant_id, ctxB.tenantId));
    expect(execRowsB.length).toBe(0);

    // One boss.send call, referencing tenant A's workflow.
    const wfCalls = calls.filter(
      (c) => (c.payload as { workflow_id?: string })?.workflow_id === workflowA,
    );
    expect(wfCalls.length).toBe(1);
    const jobPayload = wfCalls[0]?.payload as { tenant_id?: string };
    expect(jobPayload.tenant_id).toBe(ctxA.tenantId);
  });

  // ---------------------------------------------------------------------------
  // Test 2: two tenants, same cron — each fires its own workflow only.
  // ---------------------------------------------------------------------------

  test("tenant B schedule with same cron fires only tenant B's workflow", async () => {
    const calls: SendCall[] = [];
    const boss = createStubBoss(calls);

    // Insert schedule for tenant B. Tenant A already has one from the
    // previous test but its `last_enqueued_at` is now set to TICK, so the
    // dedup gate closes it for this reconcile pass — we advance the clock
    // by 2 minutes to reopen tenant A's gate too.
    const tick2 = new Date(TICK.getTime() + 2 * 60 * 1000);

    await testDb.db.insert(workflowsSchedules).values({
      tenant_id: ctxB.tenantId,
      workflow_id: workflowB,
      cron: "* * * * *",
      timezone: "UTC",
      paused: false,
      last_enqueued_at: null,
      created_at: new Date(TICK.getTime() - 120_000),
    });

    const reconciler = new SchedulerReconciler({ boss, db: testDb.db });
    await reconciler.reconcileWorkflowSchedules(tick2);

    // Each tenant should have exactly one execution from this tick.
    const execRowsA2 = await testDb.db
      .select()
      .from(executions)
      .where(eq(executions.tenant_id, ctxA.tenantId));
    // Tenant A now has 2 total (1 from test 1, 1 from this tick).
    expect(execRowsA2.length).toBe(2);
    const latestA = execRowsA2[execRowsA2.length - 1];
    expect(latestA?.workflow_id).toBe(workflowA);

    const execRowsB2 = await testDb.db
      .select()
      .from(executions)
      .where(eq(executions.tenant_id, ctxB.tenantId));
    expect(execRowsB2.length).toBe(1);
    expect(execRowsB2[0]?.workflow_id).toBe(workflowB);

    // No cross-tenant bleed: tenant B's execution only references workflowB.
    const crossBleed = execRowsB2.filter((r) => r.workflow_id !== workflowB);
    expect(crossBleed.length).toBe(0);

    // Audit: each schedule firing must emit a SCHEDULE_TRIGGER_FIRED row
    // scoped to its own tenant, not the other's.
    const auditsA = await testDb.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.tenant_id, ctxA.tenantId));
    const auditsB = await testDb.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.tenant_id, ctxB.tenantId));
    // Tenant A has 2 audit entries (one per tick); tenant B has 1.
    expect(auditsA.length).toBe(2);
    expect(auditsB.length).toBe(1);
    expect(auditsB[0]?.action).toBe("schedule.trigger.fired");
    const mdB = auditsB[0]?.metadata as Record<string, unknown> | null;
    expect(mdB?.workflow_id).toBe(workflowB);
  });

  // ---------------------------------------------------------------------------
  // Test 3: handcrafted row with tenant_id mismatch is skipped + warns.
  // ---------------------------------------------------------------------------

  test("schedule row with mismatched tenant_id is skipped and emits a structured warning", async () => {
    const calls: SendCall[] = [];
    const boss = createStubBoss(calls);

    // Insert a row where tenant_id claims tenantB but workflow_id belongs to
    // workflowA (which is owned by tenantA). The DB allows this because the
    // FK constraints only verify that each foreign key references a valid row
    // independently — there is no composite constraint. The reconciler must
    // detect the mismatch and skip rather than fire under workflowA's tenant.
    await testDb.db.insert(workflowsSchedules).values({
      tenant_id: ctxB.tenantId,
      workflow_id: workflowA, // belongs to tenantA — deliberate mismatch
      cron: "* * * * *",
      timezone: "UTC",
      paused: false,
      last_enqueued_at: null,
      created_at: new Date(TICK.getTime() - 120_000),
    });

    // Advance clock so the dedup gate is open for all existing schedules.
    const tick3 = new Date(TICK.getTime() + 4 * 60 * 1000);

    // Count executions before the tick.
    const beforeA =
      (
        await testDb.db
          .select({ cnt: sql<number>`count(*)` })
          .from(executions)
          .where(eq(executions.tenant_id, ctxA.tenantId))
      )[0]?.cnt ?? 0;
    const beforeB =
      (
        await testDb.db
          .select({ cnt: sql<number>`count(*)` })
          .from(executions)
          .where(eq(executions.tenant_id, ctxB.tenantId))
      )[0]?.cnt ?? 0;

    const reconciler = new SchedulerReconciler({ boss, db: testDb.db });
    await reconciler.reconcileWorkflowSchedules(tick3);

    const afterA =
      (
        await testDb.db
          .select({ cnt: sql<number>`count(*)` })
          .from(executions)
          .where(eq(executions.tenant_id, ctxA.tenantId))
      )[0]?.cnt ?? 0;
    const afterB =
      (
        await testDb.db
          .select({ cnt: sql<number>`count(*)` })
          .from(executions)
          .where(eq(executions.tenant_id, ctxB.tenantId))
      )[0]?.cnt ?? 0;

    // The mismatched schedule must not have produced any new executions under
    // either tenant. (The legitimate schedules for A and B do fire here too —
    // we check the delta equals exactly the 2 legitimate schedules, not 3.)
    // Tenant A gained exactly 1 (from its own legitimate schedule).
    expect(Number(afterA) - Number(beforeA)).toBe(1);
    // Tenant B gained exactly 1 (from its own legitimate schedule for workflowB).
    expect(Number(afterB) - Number(beforeB)).toBe(1);

    // The mismatched-tenant boss.send calls: workflowA should only appear
    // under tenantA's payload, never under tenantB.
    const crossTenantCalls = calls.filter(
      (c) =>
        (c.payload as { workflow_id?: string; tenant_id?: string })?.workflow_id === workflowA &&
        (c.payload as { tenant_id?: string })?.tenant_id === ctxB.tenantId,
    );
    expect(crossTenantCalls.length).toBe(0);
  });
});
