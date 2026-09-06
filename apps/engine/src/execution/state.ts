// Persistence helpers for execution / execution_steps / outbox events.
// Keeps the engine.ts file focused on control flow.

import { and, eq, inArray, isNull } from "drizzle-orm";
import { AuditAction, type AuditActorType, auditAwait } from "../audit/index.ts";
import { assertInsertRow } from "../db/assert-insert.ts";
import type { Db, Executor } from "../db/client.ts";
import { writeEvent } from "../db/events.ts";
import { executionSteps, executions } from "../db/schema/index.ts";
import { logger } from "../logging/logger.ts";
import { recordExecutionTerminal } from "../observability/instrumentation.ts";
import type {
  ExecutionMode,
  ExecutionSourceKind,
  ExecutionStatus,
  RequestSource,
  StepResult,
  StepStatus,
} from "./types.ts";

export interface CreateExecutionParams {
  tenant_id: string;
  /** Only the server admission path supplies this. The database reserves one
   * run atomically with insertion and binds the exact version/environment. */
  execution_authority_id?: string | null;
  /** NULL for draft and step runs — those have no persisted workflow row. */
  workflow_id: string | null;
  /** NULL for draft and step runs. */
  workflow_version_id: string | null;
  source_kind: ExecutionSourceKind;
  source_ref: Record<string, unknown> | null;
  request_source: RequestSource;
  parent_execution_id?: string | null;
  execution_mode?: ExecutionMode;
  /** The caller-supplied run input — persisted so a rerun can default
   *  to the original instead of silently running with nothing. */
  input?: unknown;
  /** Caller-chosen key that makes the trigger safe to repeat; see
   *  `findExecutionByIdempotencyKey`. */
  idempotency_key?: string | null;
}

/** Postgres raises 23505 when the partial unique index on
 *  (tenant_id, idempotency_key) refuses a second run with the same key. */
export function isIdempotencyConflict(err: unknown): boolean {
  // Drizzle wraps the driver error ("Failed query: …" with the Postgres
  // error as `cause`), so walk the chain: the code and the constraint name
  // live on the innermost error, not on the one that reaches the caller.
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 5; depth += 1) {
    const e = cur as {
      code?: string;
      constraint_name?: string;
      constraint?: string;
      message?: string;
      cause?: unknown;
    };
    const named = e.constraint_name ?? e.constraint ?? "";
    const msg = e.message ?? "";
    if (
      (e.code === "23505" || msg.includes("23505") || msg.includes("duplicate key")) &&
      (named === "executions_tenant_idempotency_key_uidx" ||
        msg.includes("executions_tenant_idempotency_key_uidx"))
    ) {
      return true;
    }
    cur = e.cause;
  }
  return false;
}

/** The execution a tenant already started under this key, or null. */
export async function findExecutionByIdempotencyKey(
  db: Db,
  tenant_id: string,
  idempotency_key: string,
): Promise<{ id: string; status: ExecutionStatus } | null> {
  const [row] = await db
    .select({ id: executions.id, status: executions.status })
    .from(executions)
    .where(
      and(eq(executions.tenant_id, tenant_id), eq(executions.idempotency_key, idempotency_key)),
    )
    .limit(1);
  return row ?? null;
}

export async function createExecution(
  db: Executor,
  params: CreateExecutionParams,
): Promise<string> {
  const id = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(executions)
      .values({
        tenant_id: params.tenant_id,
        execution_authority_id: params.execution_authority_id ?? null,
        workflow_id: params.workflow_id,
        workflow_version_id: params.workflow_version_id,
        source_kind: params.source_kind,
        source_ref: params.source_ref,
        status: "queued",
        request_source: params.request_source,
        execution_mode: params.execution_mode ?? "dev",
        parent_execution_id: params.parent_execution_id ?? null,
        input: params.input ?? null,
        idempotency_key: params.idempotency_key ?? null,
      })
      .returning({ id: executions.id });
    assertInsertRow(row, "executions");
    await writeEvent(tx, {
      tenant_id: params.tenant_id,
      channel: "execution.status",
      type: "execution.queued",
      payload: {
        execution_id: row.id,
        ...(params.execution_authority_id
          ? { execution_authority_id: params.execution_authority_id }
          : {}),
        workflow_id: params.workflow_id,
        source_kind: params.source_kind,
        request_source: params.request_source,
        parent_execution_id: params.parent_execution_id ?? null,
      },
    });
    return row.id;
  });
  logger.info({
    module: "execution",
    action: "execution.queued",
    msg: "execution created",
    execution_id: id,
    workflow_id: params.workflow_id ?? null,
    source_kind: params.source_kind,
    request_source: params.request_source,
  });
  return id;
}

export async function markExecutionRunning(
  db: Db,
  tenant_id: string,
  execution_id: string,
  // Caller-captured run instant — persisted as `started_at` AND reused as the
  // single sandbox clock (per-step + workflow-scope) so `sk.now()` mirrors the
  // row's `started_at` and every sandbox in the run shares one instant.
  started_at: Date,
): Promise<boolean> {
  let applied = false;
  await db.transaction(async (tx) => {
    const rows = await tx
      .update(executions)
      .set({ status: "running", started_at })
      .where(
        and(
          eq(executions.tenant_id, tenant_id),
          eq(executions.id, execution_id),
          eq(executions.status, "queued"),
          isNull(executions.abort_requested_at),
        ),
      )
      .returning({ id: executions.id });
    if (!rows[0]) return;
    applied = true;
    await writeEvent(tx, {
      tenant_id,
      channel: "execution.status",
      type: "execution.started",
      payload: { execution_id },
    });
  });
  if (!applied) return false;
  logger.info({
    module: "execution",
    action: "execution.started",
    msg: "execution started",
    execution_id,
  });
  return true;
}

export interface RequestExecutionAbortParams {
  tenant_id: string;
  execution_id: string;
  actor_type: AuditActorType;
  actor_id: string | null;
  request_source: string;
}

/** Persist one idempotent cancellation intent before attempting local delivery. */
export async function requestExecutionAbort(
  db: Db,
  params: RequestExecutionAbortParams,
): Promise<boolean> {
  let applied = false;
  await db.transaction(async (tx) => {
    const requestedAt = new Date();
    const rows = await tx
      .update(executions)
      .set({ abort_requested_at: requestedAt })
      .where(
        and(
          eq(executions.tenant_id, params.tenant_id),
          eq(executions.id, params.execution_id),
          inArray(executions.status, NON_TERMINAL_STATUSES),
          isNull(executions.abort_requested_at),
        ),
      )
      .returning({ id: executions.id });
    if (!rows[0]) return;
    applied = true;
    await writeEvent(tx, {
      tenant_id: params.tenant_id,
      channel: "execution.status",
      type: "execution.abort_requested",
      payload: { execution_id: params.execution_id },
    });
    await auditAwait(
      {
        tenant_id: params.tenant_id,
        actor_type: params.actor_type,
        actor_id: params.actor_id,
        action: AuditAction.EXECUTION_ABORT_REQUESTED,
        resource_type: "execution",
        resource_id: params.execution_id,
        result: "success",
        metadata: { request_source: params.request_source },
      },
      tx,
    );
  });
  return applied;
}

/** Failure detail carried into the `execution.failed` event payload so a
 *  notification / webhook names what broke without a follow-up lookup. */
export interface ExecutionFailureDetail {
  step_id: string | null;
  error_code: string;
  error_message: string;
}

// Non-terminal statuses. A finalize may only move a row OUT of one of
// these — once a row is terminal it must never be overwritten.
const NON_TERMINAL_STATUSES: ExecutionStatus[] = ["queued", "running"];

export async function finalizeExecution(
  db: Db,
  tenant_id: string,
  execution_id: string,
  status: ExecutionStatus,
  result_storage_uri: string | null,
  failure?: ExecutionFailureDetail | null,
  // Compare-and-set guard: the transition only applies when the row is
  // currently in one of these statuses. Defaults to the non-terminal set,
  // so completion / cancel / timeout racing on the same execution become
  // first-writer-wins instead of last-write-clobbers. Callers that must
  // only act on a specific prior state (e.g. queued-cancel) narrow it.
  expectedStatuses: ExecutionStatus[] = NON_TERMINAL_STATUSES,
  result_sha256: string | null = null,
): Promise<void> {
  // workflow_id is NULL for draft and step runs; observability code must
  // handle the null case (e.g. report duration without workflow breakdown).
  let workflow_id: string | null = null;
  let request_source: string = "api";
  let duration_ms: number | null = null;
  let applied = false;
  await db.transaction(async (tx) => {
    const updated = await tx
      .update(executions)
      .set({
        status,
        finished_at: new Date(),
        result_storage_uri,
        result_sha256,
      })
      .where(and(eq(executions.id, execution_id), inArray(executions.status, expectedStatuses)))
      .returning({
        id: executions.id,
        workflow_id: executions.workflow_id,
        request_source: executions.request_source,
        started_at: executions.started_at,
        finished_at: executions.finished_at,
      });
    const row = updated[0];
    if (!row) {
      // Another terminal transition already won (or the row vanished). Do
      // not emit a second terminal event or double-count metrics.
      return;
    }
    applied = true;
    workflow_id = row.workflow_id ?? null;
    request_source = row.request_source ?? "api";
    if (row.started_at && row.finished_at) {
      duration_ms = row.finished_at.getTime() - row.started_at.getTime();
    }
    // Enrich the event payload with the workflow + source + failure
    // reason so a downstream `event.fanout` → notification / webhook can
    // tell the user *what* failed and *why* without re-querying.
    await writeEvent(tx, {
      tenant_id,
      channel: "execution.status",
      type: `execution.${status}`,
      payload: {
        execution_id,
        status,
        workflow_id,
        request_source,
        ...(failure ? { failure } : {}),
      },
    });
  });
  if (!applied) {
    logger.info({
      module: "execution",
      action: "execution.finalize_noop",
      msg: "finalize skipped — execution already terminal",
      execution_id,
      attempted_status: status,
    });
    return;
  }
  logger.info({
    module: "execution",
    action: `execution.${status}`,
    msg: `execution ${status}`,
    execution_id,
  });
  recordExecutionTerminal({
    tenant_id,
    workflow_id: workflow_id ?? "",
    status,
    request_source,
    duration_ms,
  });
}

export async function insertStepRow(
  db: Db,
  params: {
    tenant_id: string;
    execution_id: string;
    step_key: string;
    step_index: number;
    kind: string;
  },
): Promise<string> {
  // The step event commits atomically with the step row so an SSE
  // follower never sees a step that isn't persisted (or vice versa).
  // Payload carries `execution_id` — the outbox tail's per-execution
  // filter picks step frames up with no extra plumbing.
  return await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(executionSteps)
      .values({
        tenant_id: params.tenant_id,
        execution_id: params.execution_id,
        step_key: params.step_key,
        step_index: params.step_index,
        kind: params.kind,
        status: "running",
        started_at: new Date(),
      })
      .returning({ id: executionSteps.id });
    assertInsertRow(row, "execution_steps");
    await writeEvent(tx, {
      tenant_id: params.tenant_id,
      channel: "execution.status",
      type: "execution.step.started",
      payload: {
        execution_id: params.execution_id,
        step_key: params.step_key,
        step_index: params.step_index,
        kind: params.kind,
        status: "running",
      },
    });
    return row.id;
  });
}

export async function finalizeStepRow(
  db: Db,
  step_row_id: string,
  status: StepStatus,
  result: StepResult,
  options: {
    output_preview: unknown | null;
    result_preview: string | null;
    result_storage_uri: string | null;
    result_sha256?: string | null;
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    const updated = await tx
      .update(executionSteps)
      .set({
        status,
        finished_at: new Date(),
        duration_ms: result.duration_ms,
        retry_count: result.retry_count,
        output_preview: options.output_preview ?? null,
        result_preview: options.result_preview,
        result_storage_uri: options.result_storage_uri,
        result_sha256: options.result_sha256 ?? null,
        request_meta: result.request_meta ?? null,
        error: result.error ?? null,
      })
      // A recovery sweep may have terminalized this row after its worker
      // disappeared. Keep step completion first-writer-wins just like the
      // execution-level finalize path; a late worker must not resurrect a
      // recovered `aborted` or `timed_out` step.
      .where(and(eq(executionSteps.id, step_row_id), eq(executionSteps.status, "running")))
      .returning({
        tenant_id: executionSteps.tenant_id,
        execution_id: executionSteps.execution_id,
        step_key: executionSteps.step_key,
        step_index: executionSteps.step_index,
        kind: executionSteps.kind,
      });
    const row = updated[0];
    if (!row) return;
    await writeEvent(tx, {
      tenant_id: row.tenant_id,
      channel: "execution.status",
      type: "execution.step.finished",
      payload: {
        execution_id: row.execution_id,
        step_key: row.step_key,
        step_index: row.step_index,
        kind: row.kind,
        status,
        duration_ms: result.duration_ms,
        ...(result.error ? { error_code: result.error.code } : {}),
      },
    });
  });
}
