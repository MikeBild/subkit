// Wait step. Same-day in-process pause with restart-safe
// resumption: a checkpoint row in `workflow_waits` is written before the
// setTimeout starts and deleted on completion. Engine boot reaps any
// rows still present, advancing or re-arming as needed.
//
// Cap is 24h via Zod (`WaitStepSchema.duration_ms.max`). Multi-day
// patterns belong on the Schedule + State recipe, not here.
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import type { WaitStep } from "../../workflows/types.ts";
import type { StepResult, StepRunContext } from "../types.ts";
import { clearWaitCheckpoint, writeWaitCheckpoint } from "./wait-checkpoint.ts";

export async function runWaitStep(p: { ctx: StepRunContext; step: WaitStep }): Promise<StepResult> {
  const start = Date.now();
  const sleepUntil = new Date(start + p.step.duration_ms);

  // Checkpoint the wait BEFORE arming the timer. If the engine dies
  // between this insert and the resolve, the boot-time reaper finds the
  // row and resumes (or re-arms) the wait. Skipped for runs the reaper
  // could not resume anyway — see `wait-checkpoint.ts`.
  await writeWaitCheckpoint(p.ctx, p.step.id, sleepUntil);

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

  await clearWaitCheckpoint(p.ctx, p.step.id);

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
