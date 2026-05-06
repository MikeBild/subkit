// Wait-for-event step (#49). Signal-driven HITL pause. Polls the
// `workflow_signals` table at a 1s cadence until a matching row arrives
// (status: succeeded with `output: { event, payload }`) or the
// per-step `timeout_ms` elapses (status: succeeded with
// `output: { timed_out: true }` so the workflow can branch on it).
//
// The step honors `signal.aborted` for graceful engine shutdown. On
// abort the row in `workflow_waits` is cleaned up and the result is
// `aborted` — same contract as #48 wait.
//
// Restart safety: the same `workflow_waits` table tracks an inflight
// wait-for-event. Engine boot's reaper resumes the poll for any row
// whose `sleep_until_ts` (here: timeout deadline) is in the future.

import { and, eq } from "drizzle-orm";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import { workflowWaits } from "../../db/schema/workflow_waits.ts";
import { consumeMatchingSignal } from "../../workflow-signals/service.ts";
import type { WaitForEventStep } from "../../workflows/types.ts";
import type { StepResult, StepRunContext } from "../types.ts";

const POLL_INTERVAL_MS = 1000;

export async function runWaitForEventStep(p: {
  ctx: StepRunContext;
  step: WaitForEventStep;
}): Promise<StepResult> {
  const start = Date.now();
  const deadline = new Date(start + p.step.timeout_ms);

  await p.ctx.db
    .insert(workflowWaits)
    .values({
      tenant_id: p.ctx.tenant_id,
      execution_id: p.ctx.execution_id,
      workflow_id: p.ctx.workflow_id,
      step_id: p.step.id,
      sleep_until_ts: deadline,
    })
    .onConflictDoUpdate({
      target: [workflowWaits.tenant_id, workflowWaits.execution_id, workflowWaits.step_id],
      set: { sleep_until_ts: deadline, updated_at: new Date() },
    });

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
        signal_event_name: p.step.event_name,
        timeout_ms: p.step.timeout_ms,
        sleep_until_ts: deadline.toISOString(),
      },
    },
    p.ctx.db,
  );

  let outcome: StepResult;
  let reason: "signal" | "timeout" | "cancelled";

  try {
    outcome = await pollUntilMatchOrTimeout(p);
    reason =
      outcome.status === "succeeded" &&
      typeof outcome.output === "object" &&
      outcome.output !== null &&
      "timed_out" in outcome.output
        ? "timeout"
        : "signal";
  } catch (err) {
    reason = "cancelled";
    outcome = {
      status: "aborted",
      retry_count: 0,
      duration_ms: Date.now() - start,
      error: { code: "aborted", message: err instanceof Error ? err.message : String(err) },
    };
  }

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
        signal_event_name: p.step.event_name,
      },
    },
    p.ctx.db,
  );

  return outcome;
}

async function pollUntilMatchOrTimeout(p: {
  ctx: StepRunContext;
  step: WaitForEventStep;
}): Promise<StepResult> {
  const start = Date.now();
  const deadlineMs = start + p.step.timeout_ms;
  while (true) {
    if (p.ctx.signal.aborted) throw new Error("aborted");
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) {
      return {
        status: "succeeded",
        output: { timed_out: true, event: p.step.event_name },
        retry_count: 0,
        duration_ms: Date.now() - start,
      };
    }
    const found = await consumeMatchingSignal(p.ctx.db, {
      tenant_id: p.ctx.tenant_id,
      execution_id: p.ctx.execution_id,
      event_name: p.step.event_name,
      ...(p.step.match
        ? {
            match: {
              path: p.step.match.path,
              equals: p.step.match.equals as string | number | boolean | null,
            },
          }
        : {}),
    });
    if (found) {
      return {
        status: "succeeded",
        output: {
          event: p.step.event_name,
          payload: found.payload,
          received_at: found.received_at.toISOString(),
        },
        retry_count: 0,
        duration_ms: Date.now() - start,
      };
    }
    await sleepWithAbort(Math.min(POLL_INTERVAL_MS, Math.max(50, remaining)), p.ctx.signal);
  }
}

function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
