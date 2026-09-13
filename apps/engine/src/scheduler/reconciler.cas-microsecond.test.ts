// Reconciler CAS microsecond-safety test.
//
// node-postgres truncates timestamptz to millisecond precision when it
// parses a row into a JS Date. A compare-and-set that reads a stamp back
// and then matches it with a raw `= value` therefore never matches a
// stored value carrying sub-millisecond microseconds — the UPDATE touches
// 0 rows and that schedule / tenant stalls forever.
//
// This file pins that both reconcile sweeps survive a microsecond-precision
// stamp:
//   - workflow schedules: the CAS truncates both sides via date_trunc, so a
//     due schedule still fires.
//   - proactive drift scan: the claim is a range-based atomic UPDATE, so a
//     due tenant is still claimed (stamp advances + a scan row is written).
//
// Both stamps are written with an explicit `.123456` microsecond literal —
// the exact shape the old equality-CAS could not match.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";

import { selfHealingScans, tenants, workflowsSchedules } from "../db/schema/index.ts";
import {
  createEngineCtx,
  createWorkflowRow,
  type EngineTestCtx,
} from "../execution/tests/setup.ts";
import { SchedulerReconciler } from "./reconciler.ts";
import { grantScheduleAuthorityFixture } from "./tests/authority-fixture.ts";

let ctx: EngineTestCtx;

beforeAll(async () => {
  ctx = await createEngineCtx("sched-cas-us");
}, 30_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

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

describe("reconciler CAS is microsecond-safe", () => {
  test("workflow schedule with microsecond last_enqueued_at still fires", async () => {
    const calls: SendCall[] = [];
    const boss = createStubBoss(calls);
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "cas-us-wf",
      slug: "cas-us-wf",
      steps: [{ id: "noop", kind: "transform", expression: "$input" }],
    });
    await grantScheduleAuthorityFixture(ctx.testDb.db, ctx.tenantId, workflow_id);
    const [row] = await ctx.testDb.db
      .insert(workflowsSchedules)
      .values({
        tenant_id: ctx.tenantId,
        workflow_id,
        cron: "* * * * *",
        timezone: "UTC",
        paused: false,
        input: null,
        last_enqueued_at: null,
      })
      .returning({ id: workflowsSchedules.id });
    if (!row) throw new Error("schedule insert failed");
    // Inject a microsecond-precision last_enqueued_at one hour in the past.
    await ctx.testDb.db
      .update(workflowsSchedules)
      .set({ last_enqueued_at: sql`'2026-06-05 11:00:00.123456+00'::timestamptz` })
      .where(eq(workflowsSchedules.id, row.id));

    const reconciler = new SchedulerReconciler({ boss, db: ctx.testDb.db, intervalMs: 60_000 });
    await reconciler.reconcileWorkflowSchedules(new Date("2026-06-05T12:00:00.000Z"));

    const fires = calls.filter(
      (c) => (c.payload as { workflow_id?: string })?.workflow_id === workflow_id,
    );
    expect(fires.length).toBe(1);
  });

  test("proactive drift scan with microsecond last_proactive_scan_at claims the tenant", async () => {
    const reconciler = new SchedulerReconciler({
      boss: createStubBoss([]),
      db: ctx.testDb.db,
      intervalMs: 60_000,
    });
    // Inject a microsecond-precision last_proactive_scan_at two hours in the
    // past (the cadence is one hour, so the tenant is due).
    await ctx.testDb.db
      .update(tenants)
      .set({ last_proactive_scan_at: sql`'2026-06-05 10:00:00.123456+00'::timestamptz` })
      .where(eq(tenants.id, ctx.tenantId));

    const before = await ctx.testDb.db
      .select({ id: selfHealingScans.id })
      .from(selfHealingScans)
      .where(eq(selfHealingScans.tenant_id, ctx.tenantId));

    const now = new Date("2026-06-05T12:00:00.000Z");
    await reconciler.reconcileProactiveDriftScans(now);

    // Stamp advanced to `now` (claimed despite the microsecond stored value).
    const after = (
      await ctx.testDb.db.select().from(tenants).where(eq(tenants.id, ctx.tenantId))
    )[0];
    expect(after?.last_proactive_scan_at?.toISOString()).toBe(now.toISOString());

    // A scan row was written, proving the claim ran the per-tenant scan.
    const afterScans = await ctx.testDb.db
      .select({ id: selfHealingScans.id })
      .from(selfHealingScans)
      .where(eq(selfHealingScans.tenant_id, ctx.tenantId));
    expect(afterScans.length).toBeGreaterThan(before.length);
  });
});
