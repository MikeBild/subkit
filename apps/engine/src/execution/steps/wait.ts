// Wait step (#48 SHRUNK). Same-day in-process pause with restart-safe
// resumption: a checkpoint row in `workflow_waits` is written before the
// setTimeout starts and deleted on completion. Engine boot reaps any
// rows still present, advancing or re-arming as needed.
//
// Cap is 24h via Zod (`WaitStepSchema.duration_ms.max`). Multi-day
// patterns belong on the Schedule + State recipe (#51 + A8), not here.
import { and, eq } from "drizzle-orm";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import { workflowWaits } from "../../db/schema/workflow_waits.ts";
import type { WaitStep } from "../../workflows/types.ts";
import type { StepResult, StepRunContext } from "../types.ts";

export async function runWaitStep(p: { ctx: StepRunContext; step: WaitStep }): Promise<StepResult> {
  const start = Date.now();
  const sleepUntil = new Date(start + p.step.duration_ms);

  // Checkpoint the wait BEFORE arming the timer. If the engine dies
  // between this insert and the resolve, the boot-time reaper finds the
  // row and resumes (or re-arms) the wait. Idempotent on conflict —
  // a retry of the same step does not duplicate.
  await p.ctx.db
    .insert(workflowWaits)
    .values({
      tenant_id: p.ctx.tenant_id,
      execution_id: p.ctx.execution_id,
      workflow_id: p.ctx.workflow_id,
      step_id: p.step.id,
      sleep_until_ts: sleepUntil,
    })
    .onConflictDoUpdate({
      target: [workflowWaits.tenant_id, workflowWaits.execution_id, workflowWaits.step_id],
      set: { sleep_until_ts: sleepUntil, updated_at: new Date() },
    });

  // First step-level audit pair in subkit. `wait_completed` fires
  // unconditionally below (timer / cancelled / error), preserving the
  // pairing invariant the operator can grep for.
  await auditAwait(
    {
      tenant_id: p.ctx.tenant_id,
      actor_type: "system",
      action: AuditAction.WAIT_STARTED,
      resource_type: "execution",
      resource_id: p.ctx.execution_id,
      result: "success",
      metadata: {
        step_id: p.step.id,
        workflow_id: p.ctx.workflow_id,
        duration_ms: p.step.duration_ms,
        sleep_until_ts: sleepUntil.toISOString(),
      },
    },
    p.ctx.db,
  );

  let reason: "timer" | "cancelled" = "timer";
  let outcome: StepResult;
  try {
    await new Promise<void>((resolve, reject) => {
      if (p.ctx.signal.aborted) {
        reject(new Error("aborted"));
        return;
      }
      const t = setTimeout(() => {
        p.ctx.signal.removeEventListener("abort", onAbort);
        resolve();
      }, p.step.duration_ms);
      const onAbort = () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      };
      p.ctx.signal.addEventListener("abort", onAbort, { once: true });
    });
    outcome = {
      status: "succeeded",
      output: { waited_ms: p.step.duration_ms },
      retry_count: 0,
      duration_ms: Date.now() - start,
    };
  } catch {
    reason = "cancelled";
    outcome = {
      status: "aborted",
      retry_count: 0,
      duration_ms: Date.now() - start,
      error: { code: "aborted", message: "wait aborted" },
    };
  }

  // Cleanup the checkpoint row whether the wait completed or aborted.
  // The reaper only acts on rows that survived a process death; a
  // graceful exit always clears its own row.
  await p.ctx.db
    .delete(workflowWaits)
    .where(
      and(
        eq(workflowWaits.tenant_id, p.ctx.tenant_id),
        eq(workflowWaits.execution_id, p.ctx.execution_id),
        eq(workflowWaits.step_id, p.step.id),
      ),
    );

  await auditAwait(
    {
      tenant_id: p.ctx.tenant_id,
      actor_type: "system",
      action: AuditAction.WAIT_COMPLETED,
      resource_type: "execution",
      resource_id: p.ctx.execution_id,
      result: outcome.status === "succeeded" ? "success" : "error",
      metadata: {
        step_id: p.step.id,
        workflow_id: p.ctx.workflow_id,
        duration_ms: outcome.duration_ms,
        reason,
      },
    },
    p.ctx.db,
  );

  return outcome;
}
