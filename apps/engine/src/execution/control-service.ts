import { and, eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { AuditAction, actorType, auditAwait } from "../audit/index.ts";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";
import { writeEvent } from "../db/index.ts";
import { executionSteps, executions } from "../db/schema/index.ts";
import { clearDeviceWait } from "../devices/waiting.ts";
import { logger } from "../logging/index.ts";
import { enqueueHostedWork } from "../queue/hosted-work.ts";
import { findAllJobs } from "../queue/list-all.ts";
import { EXECUTION_RUN_DEVICE_QUEUE, EXECUTION_RUN_QUEUE } from "../queue/queues.ts";
import { verifySignalToken } from "../workflow-signals/index.ts";
import { cancel as abortCancel } from "./abort.ts";
import { resolvedStepState, resolveWriteVerdict, type WriteOutcome } from "./core/resume.ts";
import { executionVisibilityFilter } from "./execution-owner.ts";
import { findOwnedExecution } from "./read-service.ts";
import { finalizeExecution, requestExecutionAbort, requeueUncertainExecution } from "./state.ts";

interface CancelExecutionRequest {
  principal: ResolvedPrincipal;
  execution_id: string;
  request_source: string;
  boss?: PgBoss | undefined;
}

async function queueOf(boss: PgBoss | undefined): Promise<PgBoss> {
  if (boss) return boss;
  const { getBoss } = await import("../queue/boss.ts");
  return getBoss();
}

async function cancelQueuedJobs(boss: PgBoss | undefined, execution_id: string): Promise<void> {
  try {
    const queue = await queueOf(boss);
    for (const name of [EXECUTION_RUN_QUEUE, EXECUTION_RUN_DEVICE_QUEUE]) {
      const jobs = await findAllJobs<{ execution_id: string }>(queue, name, {
        data: { execution_id },
      });
      if (jobs.length > 0) {
        const ids = jobs.map((j: { id: string }) => j.id);
        await queue.cancel(name, ids);
      }
    }
  } catch (err) {
    logger.debug({
      module: "queue",
      action: "cancel.skipped",
      msg: "could not cancel queued job (pg-boss not started or no matching job)",
      execution_id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function cancelExecutionRequest(
  db: Db,
  request: CancelExecutionRequest,
): Promise<boolean> {
  const { principal, execution_id } = request;
  const row = await findOwnedExecution(db, principal, execution_id);
  if (!row) return false;
  if (
    row.status === "queued" ||
    row.status === "waiting_for_device" ||
    row.status === "running" ||
    row.status === "uncertain"
  ) {
    await requestExecutionAbort(db, {
      tenant_id: principal.tenant_id,
      execution_id,
      actor_type: actorType(principal),
      actor_id: principal.id,
      request_source: request.request_source,
    });
  }
  if (row.status === "queued" || row.status === "waiting_for_device") {
    await cancelQueuedJobs(request.boss, execution_id);
    await clearDeviceWait(db, principal.tenant_id, execution_id);
    await finalizeExecution(db, principal.tenant_id, execution_id, { type: "cancelled" });
  }
  if (row.status === "uncertain") {
    await finalizeExecution(db, principal.tenant_id, execution_id, { type: "aborted" });
  }
  abortCancel(execution_id, "cancelled");
  return true;
}

interface ResolveWriteRequest {
  principal: ResolvedPrincipal;
  execution_id: string;
  step_key: string;
  outcome: WriteOutcome;
  request_source: string;
  boss?: PgBoss | undefined;
  now?: Date;
}

export type ResolveWriteResult =
  | { kind: "not_found" }
  | { kind: "not_uncertain" }
  | { kind: "unknown_step" }
  | { kind: "resolved"; status: "queued" | "uncertain"; remaining: string[] };

export async function resolveUncertainWrite(
  db: Db,
  request: ResolveWriteRequest,
): Promise<ResolveWriteResult> {
  const { principal, execution_id, step_key, outcome } = request;
  const tenant_id = principal.tenant_id;
  const now = request.now ?? new Date();
  const row = await findOwnedExecution(db, principal, execution_id);
  if (!row) return { kind: "not_found" };
  const result = await db.transaction(async (tx): Promise<ResolveWriteResult> => {
    const uncertain = await tx
      .select({ step_key: executionSteps.step_key })
      .from(executionSteps)
      .where(
        and(
          eq(executionSteps.tenant_id, tenant_id),
          eq(executionSteps.execution_id, execution_id),
          eq(executionSteps.status, "uncertain"),
        ),
      )
      .for("update");
    const uncertainKeys = uncertain.map((step) => step.step_key);
    const verdict = resolveWriteVerdict({
      status: row.status,
      uncertain_step_keys: uncertainKeys,
      step_key,
    });
    if (verdict === "not_uncertain" || verdict === "unknown_step") return { kind: verdict };
    const state = resolvedStepState(outcome);
    await tx
      .update(executionSteps)
      .set({ status: state.status, finished_at: now, error: state.error })
      .where(
        and(
          eq(executionSteps.tenant_id, tenant_id),
          eq(executionSteps.execution_id, execution_id),
          eq(executionSteps.step_key, step_key),
          eq(executionSteps.status, "uncertain"),
        ),
      );
    const remaining = uncertainKeys.filter((key) => key !== step_key);
    if (verdict === "requeue") {
      const requeued = await requeueUncertainExecution(tx, tenant_id, execution_id);
      if (!requeued) return { kind: "not_uncertain" };
      await writeEvent(tx, {
        tenant_id,
        channel: "execution.status",
        type: "execution.queued",
        payload: { execution_id, workflow_id: row.workflow_id, reason: "write_resolved" },
      });
    }
    await auditAwait(
      {
        tenant_id,
        actor_type: actorType(principal),
        actor_id: principal.id,
        action: AuditAction.EXECUTION_WRITE_RESOLVED,
        resource_type: "execution",
        resource_id: execution_id,
        result: "success",
        metadata: {
          step_key,
          outcome,
          remaining: remaining.length,
          request_source: request.request_source,
          ...(row.workflow_id ? { workflow_id: row.workflow_id } : {}),
        },
      },
      tx,
    );
    return { kind: "resolved", status: verdict === "requeue" ? "queued" : "uncertain", remaining };
  });
  if (result.kind === "resolved" && result.status === "queued" && row.workflow_id) {
    await enqueueHostedWork(db, await queueOf(request.boss), "execution", EXECUTION_RUN_QUEUE, {
      tenant_id,
      workflow_id: row.workflow_id,
      execution_id,
    });
  }
  return result;
}

type SignalTarget =
  | { ok: true; tenant_id: string; input: unknown }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "token_rejected"; detail: string };

export async function findTokenSignalTarget(
  db: Db,
  params: { execution_id: string; token: string; event_name: string },
): Promise<SignalTarget> {
  // tenant-filter:exempt — token-mediated lookup by globally-unique execution_id; tenant_id is read out and verified against the signed HMAC token below
  const rows = await db
    .select({ id: executions.id, tenant_id: executions.tenant_id, input: executions.input })
    .from(executions)
    .where(eq(executions.id, params.execution_id))
    .limit(1);
  const row = rows[0];
  if (!row) return { ok: false, reason: "not_found" };
  const verdict = verifySignalToken(params.token, {
    tenant_id: row.tenant_id,
    execution_id: params.execution_id,
    event_name: params.event_name,
  });
  if (!verdict.ok) return { ok: false, reason: "token_rejected", detail: verdict.reason };
  return { ok: true, tenant_id: row.tenant_id, input: row.input };
}

export async function findPrincipalSignalTarget(
  db: Db,
  principal: ResolvedPrincipal,
  execution_id: string,
): Promise<SignalTarget> {
  const rows = await db
    .select({ id: executions.id, input: executions.input })
    .from(executions)
    .where(
      and(
        eq(executions.tenant_id, principal.tenant_id),
        eq(executions.id, execution_id),
        executionVisibilityFilter(principal),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return { ok: false, reason: "not_found" };
  return { ok: true, tenant_id: principal.tenant_id, input: row.input };
}
