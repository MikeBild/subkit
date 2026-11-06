import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { tenants } from "../db/schema/index.ts";
import { createEngineCtx, type EngineTestCtx } from "../execution/tests/setup.ts";
import { SchedulerReconciler } from "./reconciler.ts";
import { createStubBoss, type SendCall } from "./tests/stub-boss.ts";

let ctx: EngineTestCtx;

beforeAll(async () => {
  ctx = await createEngineCtx("sched-skill-candidate");
});

afterAll(async () => {
  await ctx.cleanup();
});

function analyzeCallsFor(calls: SendCall[], tenant_id: string): SendCall[] {
  return calls.filter(
    (c) =>
      c.queue === "skill-candidate.analyze" &&
      (c.payload as { tenant_id?: string })?.tenant_id === tenant_id,
  );
}

async function setStamp(tenant_id: string, at: Date | null): Promise<void> {
  await ctx.testDb.db
    .update(tenants)
    .set({ last_skill_candidate_analyze_at: at })
    .where(eq(tenants.id, tenant_id));
}

describe("reconciler skill-candidate analysis sweep", () => {
  test("never-analysed tenant fires once and stamps the column", async () => {
    const calls: SendCall[] = [];
    const boss = createStubBoss(calls);
    await setStamp(ctx.tenantId, null);

    const reconciler = new SchedulerReconciler({ boss, db: ctx.testDb.db, intervalMs: 60_000 });
    const now = new Date("2026-06-05T12:00:00.000Z");
    await reconciler.reconcileSkillCandidateAnalysis(now);

    expect(analyzeCallsFor(calls, ctx.tenantId).length).toBe(1);
    const row = (await ctx.testDb.db.select().from(tenants).where(eq(tenants.id, ctx.tenantId)))[0];
    expect(row?.last_skill_candidate_analyze_at?.toISOString()).toBe(now.toISOString());
  });

  test("does not re-fire within the cadence window", async () => {
    const calls: SendCall[] = [];
    const boss = createStubBoss(calls);
    const now = new Date("2026-06-05T12:00:00.000Z");
    await setStamp(ctx.tenantId, now);

    const reconciler = new SchedulerReconciler({ boss, db: ctx.testDb.db, intervalMs: 60_000 });
    await reconciler.reconcileSkillCandidateAnalysis(now);

    expect(analyzeCallsFor(calls, ctx.tenantId).length).toBe(0);
  });

  test("fires again once the cadence has elapsed", async () => {
    const calls: SendCall[] = [];
    const boss = createStubBoss(calls);
    const last = new Date("2026-06-05T05:00:00.000Z");
    const now = new Date("2026-06-05T12:00:00.000Z");
    await setStamp(ctx.tenantId, last);

    const reconciler = new SchedulerReconciler({ boss, db: ctx.testDb.db, intervalMs: 60_000 });
    await reconciler.reconcileSkillCandidateAnalysis(now);

    expect(analyzeCallsFor(calls, ctx.tenantId).length).toBe(1);

    await reconciler.reconcileSkillCandidateAnalysis(now);
    expect(analyzeCallsFor(calls, ctx.tenantId).length).toBe(1);
  });

  test("fires when the stored stamp carries microsecond precision (CAS is range-based)", async () => {
    const calls: SendCall[] = [];
    const boss = createStubBoss(calls);
    await ctx.testDb.db
      .update(tenants)
      .set({
        last_skill_candidate_analyze_at: sql`'2026-06-05 05:00:00.123456+00'::timestamptz`,
      })
      .where(eq(tenants.id, ctx.tenantId));

    const reconciler = new SchedulerReconciler({ boss, db: ctx.testDb.db, intervalMs: 60_000 });
    const now = new Date("2026-06-05T12:00:00.000Z");
    await reconciler.reconcileSkillCandidateAnalysis(now);

    expect(analyzeCallsFor(calls, ctx.tenantId).length).toBe(1);
  });
});
