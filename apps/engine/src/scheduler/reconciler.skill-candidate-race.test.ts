import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { tenants } from "../db/schema/index.ts";
import { createEngineCtx, type EngineTestCtx } from "../execution/tests/setup.ts";
import { SchedulerReconciler } from "./reconciler.ts";
import { createStubBoss, type SendCall } from "./tests/stub-boss.ts";

let ctx: EngineTestCtx;

beforeAll(async () => {
  ctx = await createEngineCtx("sched-skill-candidate-race");
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

function createThrowingBoss(): PgBoss {
  return {
    send: async () => {
      throw new Error("boss.send simulated failure");
    },
    schedule: async () => undefined,
    unschedule: async () => undefined,
    getQueues: async () => [],
    createQueue: async () => undefined,
    on: () => undefined,
  } as unknown as PgBoss;
}

function analyzeCalls(calls: SendCall[], tenant_id: string): SendCall[] {
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

describe("reconciler skill-candidate exactly-once race", () => {
  test("two reconcilers in parallel with NULL stamp enqueue exactly once", async () => {
    const callsA: SendCall[] = [];
    const callsB: SendCall[] = [];
    const bossA = createStubBoss(callsA);
    const bossB = createStubBoss(callsB);

    await setStamp(ctx.tenantId, null);

    const reconcilerA = new SchedulerReconciler({
      boss: bossA,
      db: ctx.testDb.db,
      intervalMs: 60_000,
    });
    const reconcilerB = new SchedulerReconciler({
      boss: bossB,
      db: ctx.testDb.db,
      intervalMs: 60_000,
    });

    const now = new Date("2026-06-06T10:00:00.000Z");

    await Promise.all([
      reconcilerA.reconcileSkillCandidateAnalysis(now),
      reconcilerB.reconcileSkillCandidateAnalysis(now),
    ]);

    const total =
      analyzeCalls(callsA, ctx.tenantId).length + analyzeCalls(callsB, ctx.tenantId).length;
    expect(total).toBe(1);
  });

  test("stamp is advanced after the race — re-run within cadence fires 0 times", async () => {
    const callsA: SendCall[] = [];
    const callsB: SendCall[] = [];
    const bossA = createStubBoss(callsA);
    const bossB = createStubBoss(callsB);

    await setStamp(ctx.tenantId, null);

    const now = new Date("2026-06-06T10:00:00.000Z");
    const reconcilerA = new SchedulerReconciler({
      boss: bossA,
      db: ctx.testDb.db,
      intervalMs: 60_000,
    });
    const reconcilerB = new SchedulerReconciler({
      boss: bossB,
      db: ctx.testDb.db,
      intervalMs: 60_000,
    });

    await Promise.all([
      reconcilerA.reconcileSkillCandidateAnalysis(now),
      reconcilerB.reconcileSkillCandidateAnalysis(now),
    ]);

    const callsC: SendCall[] = [];
    const bossC = createStubBoss(callsC);
    const reconcilerC = new SchedulerReconciler({
      boss: bossC,
      db: ctx.testDb.db,
      intervalMs: 60_000,
    });

    await reconcilerC.reconcileSkillCandidateAnalysis(now);
    expect(analyzeCalls(callsC, ctx.tenantId).length).toBe(0);
  });

  test("enqueue failure does not abort the sweep and the CAS stamp is advanced", async () => {
    const staleStamp = new Date("2026-01-01T00:00:00.000Z");
    await setStamp(ctx.tenantId, staleStamp);

    const throwingBoss = createThrowingBoss();
    const reconciler = new SchedulerReconciler({
      boss: throwingBoss,
      db: ctx.testDb.db,
      intervalMs: 60_000,
    });

    const now = new Date("2026-06-06T10:00:00.000Z");
    await expect(reconciler.reconcileSkillCandidateAnalysis(now)).resolves.toBeUndefined();

    const row = (await ctx.testDb.db.select().from(tenants).where(eq(tenants.id, ctx.tenantId)))[0];
    expect(row?.last_skill_candidate_analyze_at?.toISOString()).toBe(now.toISOString());
  });
});
