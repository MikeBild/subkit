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
import {
  events,
  executionSteps,
  executions,
  workflows,
  workflowVersions,
} from "../db/schema/index.ts";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
import { loadExecutionOutcome } from "./outcome.ts";
import { recoverCrashedExecutions, resolveCrashRecoveryThresholdMs } from "./recovery.ts";
import { createEngineCtx, createWorkflowRow, type EngineTestCtx } from "./tests/setup.ts";

// Recovery sweep reads real `Date.now()` to compute age; tests must
// pin their reference clock against today's wall clock or every
// "1h ago" insertion ages indefinitely past the 9h threshold and
// gets reaped (the prior hard-coded TEST_NOW_MS = 1_700_000_000_000
// expired in Nov 2023 + the test silently broke as soon as CI ran
// past that date).
const TEST_NOW_MS = getTestNow();

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
  test("a run that crashed between steps still records why it stopped", async () => {
    const { workflow_id, version_id } = await createWorkflowRow(ctx, {
      name: "crash-recovery-between-steps",
      slug: "crash-recovery-between-steps",
      timeout_ms: 1_000,
      steps: [{ id: "noop", kind: "transform", expression: "$input" }],
    });
    // No running step row: the worker died after one step finished and
    // before the next one started.
    const stuckId = await insertRunningExecution(workflow_id, version_id, 5_000);
    await recoverCrashedExecutions(ctx.testDb.db, { now: new Date(TEST_NOW_MS) });
    const row = (
      await ctx.testDb.db.select().from(executions).where(eq(executions.id, stuckId))
    )[0];
    if (!row) throw new Error("execution row missing");
    expect(row.status).toBe("timed_out");
    expect(row.failure?.error_code).toBe("engine_crash_recovery");
    const outcome = await loadExecutionOutcome(ctx.tenantId, row, ctx.testDb.db);
    expect(outcome.kind).toBe("failed");
    expect(outcome.cause_class).toBe("timeout");
    expect(outcome.error_code).toBe("engine_crash_recovery");
  });

  test("uses the immutable workflow version bound to the execution", async () => {
    const { workflow_id, version_id } = await createWorkflowRow(ctx, {
      name: "crash-recovery-version-binding",
      slug: "crash-recovery-version-binding",
      timeout_ms: 1_000,
      steps: [{ id: "noop", kind: "transform", expression: "$input" }],
    });
    const stuckId = await insertRunningExecution(workflow_id, version_id, 2_000);

    const [replacement] = await ctx.testDb.db
      .insert(workflowVersions)
      .values({
        tenant_id: ctx.tenantId,
        workflow_id,
        version: 2,
        dag: {
          name: "crash-recovery-version-binding",
          slug: "crash-recovery-version-binding",
          timeout_ms: 60_000,
          steps: [{ id: "noop", kind: "transform", expression: "$input" }],
        },
      })
      .returning({ id: workflowVersions.id });
    if (!replacement) throw new Error("replacement workflow version insert failed");
    await ctx.testDb.db
      .update(workflows)
      .set({ current_version_id: replacement.id })
      .where(eq(workflows.id, workflow_id));

    const { recovered } = await recoverCrashedExecutions(ctx.testDb.db, {
      now: new Date(TEST_NOW_MS),
    });
    expect(recovered).toBe(1);
    const row = (
      await ctx.testDb.db.select().from(executions).where(eq(executions.id, stuckId))
    )[0];
    expect(row?.status).toBe("timed_out");
  });

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
    const [stuckStep] = await ctx.testDb.db
      .insert(executionSteps)
      .values({
        tenant_id: ctx.tenantId,
        execution_id: stuckId,
        step_key: "stuck-request",
        step_index: 0,
        kind: "request",
        status: "running",
        started_at: new Date(TEST_NOW_MS - 60_000),
      })
      .returning({ id: executionSteps.id });
    if (!stuckStep) throw new Error("step insert failed");
    // Started 1h ago — well under the threshold.
    const liveId = await insertRunningExecution(workflow_id, version_id, 60 * 60 * 1000);

    const { recovered } = await recoverCrashedExecutions(ctx.testDb.db);
    expect(recovered).toBe(1);

    const stuckRow = (
      await ctx.testDb.db.select().from(executions).where(eq(executions.id, stuckId))
    )[0];
    expect(stuckRow?.status).toBe("timed_out");
    expect(stuckRow?.finished_at).not.toBeNull();
    const recoveredStep = (
      await ctx.testDb.db.select().from(executionSteps).where(eq(executionSteps.id, stuckStep.id))
    )[0];
    expect(recoveredStep?.status).toBe("timed_out");
    expect(recoveredStep?.finished_at).not.toBeNull();
    expect(recoveredStep?.duration_ms).toBeGreaterThanOrEqual(60_000);
    expect((recoveredStep?.error as { code?: string } | null)?.code).toBe("timed_out");

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
    expect(meta.recovered_status).toBe("timed_out");
  });

  test("honours a durable abort request immediately and terminalizes its running step", async () => {
    const { workflow_id, version_id } = await createWorkflowRow(ctx, {
      name: "crash-recovery-abort-requested",
      slug: "crash-recovery-abort-requested",
      timeout_ms: 4 * 60 * 60 * 1000,
      steps: [{ id: "slow", kind: "transform", expression: "$input" }],
    });
    const executionId = await insertRunningExecution(workflow_id, version_id, 60_000);
    const abortRequestedAt = new Date(TEST_NOW_MS - 5_000);
    await ctx.testDb.db
      .update(executions)
      .set({ abort_requested_at: abortRequestedAt })
      .where(eq(executions.id, executionId));
    const [step] = await ctx.testDb.db
      .insert(executionSteps)
      .values({
        tenant_id: ctx.tenantId,
        execution_id: executionId,
        step_key: "slow",
        step_index: 0,
        kind: "transform",
        status: "running",
        started_at: new Date(TEST_NOW_MS - 30_000),
      })
      .returning({ id: executionSteps.id });
    if (!step) throw new Error("step insert failed");

    const { recovered } = await recoverCrashedExecutions(ctx.testDb.db, {
      now: new Date(TEST_NOW_MS),
    });
    expect(recovered).toBe(1);

    const execution = (
      await ctx.testDb.db.select().from(executions).where(eq(executions.id, executionId))
    )[0];
    expect(execution?.status).toBe("aborted");
    expect(execution?.finished_at).not.toBeNull();

    const recoveredStep = (
      await ctx.testDb.db.select().from(executionSteps).where(eq(executionSteps.id, step.id))
    )[0];
    expect(recoveredStep?.status).toBe("aborted");
    expect(recoveredStep?.finished_at).not.toBeNull();
    expect((recoveredStep?.error as { code?: string } | null)?.code).toBe("aborted");

    const audits = await ctx.testDb.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "execution.crash_recovered"),
          eq(auditLog.resource_id, executionId),
        ),
      );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.reason).toBe("engine_crash_recovery_abort_requested");
    const metadata = audits[0]?.metadata as Record<string, unknown>;
    expect(metadata.recovered_status).toBe("aborted");
    expect(metadata.abort_requested_at).toBe(abortRequestedAt.toISOString());
  });

  test("repairs running steps whose parent execution was already terminalized", async () => {
    const { workflow_id, version_id } = await createWorkflowRow(ctx, {
      name: "crash-recovery-historical-step-invariant",
      slug: "crash-recovery-historical-step-invariant",
      steps: [{ id: "orphaned-step", kind: "transform", expression: "$input" }],
    });
    const executionId = await insertRunningExecution(workflow_id, version_id, 60_000);
    const parentFinishedAt = new Date(TEST_NOW_MS - 10_000);
    await ctx.testDb.db
      .update(executions)
      .set({ status: "timed_out", finished_at: parentFinishedAt })
      .where(eq(executions.id, executionId));
    const [step] = await ctx.testDb.db
      .insert(executionSteps)
      .values({
        tenant_id: ctx.tenantId,
        execution_id: executionId,
        step_key: "orphaned-step",
        step_index: 0,
        kind: "transform",
        status: "running",
        started_at: new Date(TEST_NOW_MS - 30_000),
      })
      .returning({ id: executionSteps.id });
    if (!step) throw new Error("step insert failed");

    const first = await recoverCrashedExecutions(ctx.testDb.db, {
      now: new Date(TEST_NOW_MS),
    });
    expect(first).toEqual({ recovered: 0, reconciled_steps: 1 });

    const recoveredStep = (
      await ctx.testDb.db.select().from(executionSteps).where(eq(executionSteps.id, step.id))
    )[0];
    expect(recoveredStep?.status).toBe("timed_out");
    expect(recoveredStep?.finished_at).toEqual(parentFinishedAt);
    expect(recoveredStep?.duration_ms).toBe(20_000);
    expect((recoveredStep?.error as { code?: string } | null)?.code).toBe("timed_out");

    const audits = await ctx.testDb.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "execution.crash_recovered"),
          eq(auditLog.resource_id, executionId),
        ),
      );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.reason).toBe("execution_step_state_reconciliation");
    const metadata = audits[0]?.metadata as Record<string, unknown>;
    expect(metadata.reconciled_step_count).toBe(1);
    expect(metadata.recovered_status).toBe("timed_out");

    const stepEvents = await ctx.testDb.db
      .select()
      .from(events)
      .where(and(eq(events.tenant_id, ctx.tenantId), eq(events.type, "execution.step.finished")));
    expect(
      stepEvents.some((event) => {
        const payload = event.payload as Record<string, unknown>;
        return (
          payload.execution_id === executionId &&
          payload.reason === "execution_step_state_reconciliation" &&
          payload.status === "timed_out"
        );
      }),
    ).toBe(true);

    const second = await recoverCrashedExecutions(ctx.testDb.db, {
      now: new Date(TEST_NOW_MS + 1_000),
    });
    expect(second).toEqual({ recovered: 0, reconciled_steps: 0 });
    const auditsAfterRetry = await ctx.testDb.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "execution.crash_recovered"),
          eq(auditLog.resource_id, executionId),
        ),
      );
    expect(auditsAfterRetry).toHaveLength(1);
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
