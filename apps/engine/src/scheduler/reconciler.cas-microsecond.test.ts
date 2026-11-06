import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { selfHealingScans, tenants, workflowsSchedules } from "../db/schema/index.ts";
import {
  createEngineCtx,
  createWorkflowRow,
  type EngineTestCtx,
} from "../execution/tests/setup.ts";
import { SchedulerReconciler } from "./reconciler.ts";
import { grantScheduleAuthorityFixture } from "./tests/authority-fixture.ts";
import { createStubBoss, type SendCall } from "./tests/stub-boss.ts";

let ctx: EngineTestCtx;

beforeAll(async () => {
  ctx = await createEngineCtx("sched-cas-us");
}, 30_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

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

    const after = (
      await ctx.testDb.db.select().from(tenants).where(eq(tenants.id, ctx.tenantId))
    )[0];
    expect(after?.last_proactive_scan_at?.toISOString()).toBe(now.toISOString());

    const afterScans = await ctx.testDb.db
      .select({ id: selfHealingScans.id })
      .from(selfHealingScans)
      .where(eq(selfHealingScans.tenant_id, ctx.tenantId));
    expect(afterScans.length).toBeGreaterThan(before.length);
  });
});
