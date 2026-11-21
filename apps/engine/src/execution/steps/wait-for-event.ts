import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import { consumeMatchingSignal } from "../../workflow-signals/index.ts";
import type { WaitForEventStep } from "../../workflows/types.ts";
import type { StepResult, StepRunContext } from "../types.ts";
import { clearWaitCheckpoint, writeWaitCheckpoint } from "./wait-checkpoint.ts";

const POLL_INTERVAL_MS = 1000;

export async function runWaitForEventStep(p: {
  ctx: StepRunContext;
  step: WaitForEventStep;
}): Promise<StepResult> {
  const start = Date.now();
  const deadline = new Date(start + p.step.timeout_ms);

  await writeWaitCheckpoint(p.ctx, p.step.id, deadline);

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
