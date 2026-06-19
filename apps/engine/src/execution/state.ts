// Persistence helpers for execution / execution_steps / outbox events.
// Keeps the engine.ts file focused on control flow.

import { eq } from "drizzle-orm";
import { assertInsertRow } from "../db/assert-insert.ts";
import type { Db } from "../db/client.ts";
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
}

export async function createExecution(db: Db, params: CreateExecutionParams): Promise<string> {
  const id = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(executions)
      .values({
        tenant_id: params.tenant_id,
        workflow_id: params.workflow_id,
        workflow_version_id: params.workflow_version_id,
        source_kind: params.source_kind,
        source_ref: params.source_ref,
        status: "queued",
        request_source: params.request_source,
        execution_mode: params.execution_mode ?? "dev",
        parent_execution_id: params.parent_execution_id ?? null,
        input: params.input ?? null,
      })
      .returning({ id: executions.id });
    assertInsertRow(row, "executions");
    await writeEvent(tx, {
      tenant_id: params.tenant_id,
      channel: "execution.status",
      type: "execution.queued",
      payload: {
        execution_id: row.id,
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
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(executions)
      .set({ status: "running", started_at: new Date() })
      .where(eq(executions.id, execution_id));
    await writeEvent(tx, {
      tenant_id,
      channel: "execution.status",
      type: "execution.started",
      payload: { execution_id },
    });
  });
  logger.info({
    module: "execution",
    action: "execution.started",
    msg: "execution started",
    execution_id,
  });
}

/** Failure detail carried into the `execution.failed` event payload so a
 *  notification / webhook names what broke without a follow-up lookup. */
export interface ExecutionFailureDetail {
  step_id: string | null;
  error_code: string;
  error_message: string;
}

export async function finalizeExecution(
  db: Db,
  tenant_id: string,
  execution_id: string,
  status: ExecutionStatus,
  result_storage_uri: string | null,
  failure?: ExecutionFailureDetail | null,
): Promise<void> {
  // workflow_id is NULL for draft and step runs; observability code must
  // handle the null case (e.g. report duration without workflow breakdown).
  let workflow_id: string | null = null;
  let request_source: string = "api";
  let duration_ms: number | null = null;
  await db.transaction(async (tx) => {
    const updated = await tx
      .update(executions)
      .set({
        status,
        finished_at: new Date(),
        result_storage_uri,
      })
      .where(eq(executions.id, execution_id))
      .returning({
        id: executions.id,
        workflow_id: executions.workflow_id,
        request_source: executions.request_source,
        started_at: executions.started_at,
        finished_at: executions.finished_at,
      });
    const row = updated[0];
    if (row) {
      workflow_id = row.workflow_id ?? null;
      request_source = row.request_source ?? "api";
      if (row.started_at && row.finished_at) {
        duration_ms = row.finished_at.getTime() - row.started_at.getTime();
      }
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
        request_meta: result.request_meta ?? null,
        error: result.error ?? null,
      })
      .where(eq(executionSteps.id, step_row_id))
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
