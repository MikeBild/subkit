// Reconciler skill-candidate exactly-once race test.
//
// Mirrors reconciler.race.test.ts for workflow schedules. Two
// SchedulerReconciler instances sharing one DB, both see a tenant with
// NULL last_skill_candidate_analyze_at, both call
// reconcileSkillCandidateAnalysis(now) via Promise.all. The CAS-stamp
// in runSkillCandidateAnalysisSweep is a single
// UPDATE...WHERE...RETURNING statement — only one instance's UPDATE
// finds the row in the matching state (NULL or < cutoff) and returns
// that tenant; the other's UPDATE returns 0 rows and skips enqueue.
//
// Also covers the per-tenant enqueue-failure path: if boss.send throws,
// the CAS stamp has already advanced (the UPDATE committed), so the sweep
// does not abort and the next cadence picks up normally.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";

import { tenants } from "../db/schema/index.ts";
import { createEngineCtx, type EngineTestCtx } from "../execution/tests/setup.ts";
import { SchedulerReconciler } from "./reconciler.ts";

let ctx: EngineTestCtx;

beforeAll(async () => {
  ctx = await createEngineCtx("sched-skill-candidate-race");
}, 60_000);

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

    // First pass — claims the row.
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

    // Second pass at the same instant → stamp is already at `now` → 0 fires.
    await reconcilerC.reconcileSkillCandidateAnalysis(now);
    expect(analyzeCalls(callsC, ctx.tenantId).length).toBe(0);
  });

  test("enqueue failure does not abort the sweep and the CAS stamp is advanced", async () => {
    // Stamp the tenant as long overdue so the sweep picks it up.
    const staleStamp = new Date("2026-01-01T00:00:00.000Z");
    await setStamp(ctx.tenantId, staleStamp);

    const throwingBoss = createThrowingBoss();
    const reconciler = new SchedulerReconciler({
      boss: throwingBoss,
      db: ctx.testDb.db,
      intervalMs: 60_000,
    });

    const now = new Date("2026-06-06T10:00:00.000Z");
    // Must not throw even though boss.send fails.
    await expect(reconciler.reconcileSkillCandidateAnalysis(now)).resolves.toBeUndefined();

    // The CAS stamp must have advanced so the tenant is NOT re-swept
    // immediately on the next pass.
    const row = (await ctx.testDb.db.select().from(tenants).where(eq(tenants.id, ctx.tenantId)))[0];
    // The sweep advances the stamp to `now` BEFORE calling boss.send,
    // so even on a throw the column is set.
    expect(row?.last_skill_candidate_analyze_at?.toISOString()).toBe(now.toISOString());
  });
});
