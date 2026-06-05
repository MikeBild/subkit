// Reconciler skill-candidate analysis sweep test.
//
// `reconcileSkillCandidateAnalysis` sweeps tenants and enqueues a
// `skill-candidate.analyze` job per cadence, compare-and-setting
// `tenants.last_skill_candidate_analyze_at` so a multi-instance
// deployment fires exactly once per cadence per tenant. This file pins:
//   - a never-analysed tenant (NULL stamp) fires on the first pass and
//     stamps the column;
//   - a second pass at the same instant does NOT re-fire (cadence dedup);
//   - a pass after the cadence has elapsed fires again.
//
// We bypass pg-boss entirely by stubbing `boss.send` and counting
// invocations, isolating the reconciler's enqueue + CAS-stamp logic.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { tenants } from "../db/schema/index.ts";
import { createEngineCtx, type EngineTestCtx } from "../execution/tests/setup.ts";
import { SchedulerReconciler } from "./reconciler.ts";

let ctx: EngineTestCtx;

beforeAll(async () => {
  ctx = await createEngineCtx("sched-skill-candidate");
});

afterAll(async () => {
  await ctx.cleanup();
});

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
    // Stamp = now, so the same-instant pass is inside the cadence.
    const now = new Date("2026-06-05T12:00:00.000Z");
    await setStamp(ctx.tenantId, now);

    const reconciler = new SchedulerReconciler({ boss, db: ctx.testDb.db, intervalMs: 60_000 });
    await reconciler.reconcileSkillCandidateAnalysis(now);

    expect(analyzeCallsFor(calls, ctx.tenantId).length).toBe(0);
  });

  test("fires again once the cadence has elapsed", async () => {
    const calls: SendCall[] = [];
    const boss = createStubBoss(calls);
    // Stamp 7h ago; cadence is 6h, so the tenant is due again.
    const last = new Date("2026-06-05T05:00:00.000Z");
    const now = new Date("2026-06-05T12:00:00.000Z");
    await setStamp(ctx.tenantId, last);

    const reconciler = new SchedulerReconciler({ boss, db: ctx.testDb.db, intervalMs: 60_000 });
    await reconciler.reconcileSkillCandidateAnalysis(now);

    expect(analyzeCallsFor(calls, ctx.tenantId).length).toBe(1);

    // Same instant again → stamp is now `now`, no second fire.
    await reconciler.reconcileSkillCandidateAnalysis(now);
    expect(analyzeCallsFor(calls, ctx.tenantId).length).toBe(1);
  });
});
