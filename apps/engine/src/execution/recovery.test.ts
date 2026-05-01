// Crash recovery sweep test.
//
// Asserts the boot-time `recoverCrashedExecutions` reaper:
//   1. Promotes a `running` execution older than the workflow's
//      `timeout_ms × 1.5` window to `timed_out`.
//   2. Writes an `execution.crash_recovered` audit row with the
//      timing context.
//   3. Leaves a `running` execution well under the threshold alone.
//   4. Honours the env-var override threshold.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog } from "../db/schema/audit.ts";
import { executions } from "../db/schema/index.ts";
import { recoverCrashedExecutions, resolveCrashRecoveryThresholdMs } from "./recovery.ts";
import { createEngineCtx, createWorkflowRow, type EngineTestCtx } from "./tests/setup.ts";

// Recovery sweep reads real `Date.now()` to compute age; tests must
// pin their reference clock against today's wall clock or every
// "1h ago" insertion ages indefinitely past the 9h threshold and
// gets reaped (the prior hard-coded TEST_NOW_MS = 1_700_000_000_000
// expired in Nov 2023 + the test silently broke as soon as CI ran
// past that date).
const TEST_NOW_MS = Date.now();

let ctx: EngineTestCtx;

beforeAll(async () => {
  ctx = await createEngineCtx("crash-recovery");
});

afterAll(async () => {
  await ctx.cleanup();
});

async function insertRunningExecution(
  workflow_id: string,
  workflow_version_id: string,
  startedMsAgo: number,
): Promise<string> {
  const startedAt = new Date(TEST_NOW_MS - startedMsAgo);
  const [row] = await ctx.testDb.db
    .insert(executions)
    .values({
      tenant_id: ctx.tenantId,
      workflow_id,
      workflow_version_id,
      source_kind: "saved",
      source_ref: null,
      status: "running",
      request_source: "api",
      execution_mode: "dev",
      started_at: startedAt,
    })
    .returning({ id: executions.id });
  if (!row) throw new Error("execution insert failed");
  return row.id;
}

describe("recoverCrashedExecutions", () => {
  test("promotes a running execution past timeout_ms × 1.5", async () => {
    const { workflow_id, version_id } = await createWorkflowRow(ctx, {
      name: "crash-recovery-wf-1",
      slug: "crash-recovery-wf-1",
      // 6h workflow timeout — threshold is 9h.
      timeout_ms: 6 * 60 * 60 * 1000,
      steps: [{ id: "noop", kind: "transform", expression: "$input" }],
    });

    // Started 12h ago — well past the 9h grace window.
    const stuckId = await insertRunningExecution(workflow_id, version_id, 12 * 60 * 60 * 1000);
    // Started 1h ago — well under the threshold.
    const liveId = await insertRunningExecution(workflow_id, version_id, 60 * 60 * 1000);

    const { recovered } = await recoverCrashedExecutions(ctx.testDb.db);
    expect(recovered).toBe(1);

    const stuckRow = (
      await ctx.testDb.db.select().from(executions).where(eq(executions.id, stuckId))
    )[0];
    expect(stuckRow?.status).toBe("timed_out");
    expect(stuckRow?.finished_at).not.toBeNull();

    const liveRow = (
      await ctx.testDb.db.select().from(executions).where(eq(executions.id, liveId))
    )[0];
    expect(liveRow?.status).toBe("running");
    expect(liveRow?.finished_at).toBeNull();

    // Audit row written with the right shape.
    const audits = await ctx.testDb.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, "execution.crash_recovered"), eq(auditLog.resource_id, stuckId)),
      );
    expect(audits.length).toBe(1);
    const audit = audits[0];
    expect(audit?.reason).toBe("engine_crash_recovery");
    expect(audit?.actor_type).toBe("system");
    const meta = audit?.metadata as Record<string, unknown>;
    expect(meta.actor_type).toBe("system");
    expect(typeof meta.started_at).toBe("string");
    expect(typeof meta.recovered_at).toBe("string");
    expect(typeof meta.timeout_ms).toBe("number");
    expect(meta.workflow_id).toBe(workflow_id);
    expect(meta.source).toBe("boot_recovery");
  });

  test("default threshold is 9h when workflow has no timeout_ms", async () => {
    const { workflow_id, version_id } = await createWorkflowRow(ctx, {
      name: "crash-recovery-wf-2",
      slug: "crash-recovery-wf-2",
      // No timeout_ms — engine falls back to 6h × 1.5 = 9h.
      steps: [{ id: "noop", kind: "transform", expression: "$input" }],
    });

    // 8h is under the 9h default — should NOT be reaped.
    const safeId = await insertRunningExecution(workflow_id, version_id, 8 * 60 * 60 * 1000);
    // 10h is over — should be reaped.
    const reapedId = await insertRunningExecution(workflow_id, version_id, 10 * 60 * 60 * 1000);

    const { recovered } = await recoverCrashedExecutions(ctx.testDb.db);
    expect(recovered).toBe(1);

    const safeRow = (
      await ctx.testDb.db.select().from(executions).where(eq(executions.id, safeId))
    )[0];
    expect(safeRow?.status).toBe("running");

    const reapedRow = (
      await ctx.testDb.db.select().from(executions).where(eq(executions.id, reapedId))
    )[0];
    expect(reapedRow?.status).toBe("timed_out");
  });

  test("env override clamps the threshold", () => {
    expect(resolveCrashRecoveryThresholdMs(undefined)).toBeUndefined();
    expect(resolveCrashRecoveryThresholdMs("not-a-number")).toBeUndefined();
    expect(resolveCrashRecoveryThresholdMs("0")).toBeUndefined();
    expect(resolveCrashRecoveryThresholdMs("60000")).toBe(60_000);
  });
});
