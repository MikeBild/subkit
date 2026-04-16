// Persistence helpers for execution / execution_steps / outbox events.
// Keeps the engine.ts file focused on control flow.

import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { writeEvent } from "../db/events.ts";
import { executionSteps, executions } from "../db/schema/index.ts";
import { logger } from "../logging/logger.ts";
import { recordExecutionTerminal } from "../observability/instrumentation.ts";
import type {
  ExecutionMode,
  ExecutionStatus,
  RequestSource,
  StepResult,
  StepStatus,
} from "./types.ts";

export interface CreateExecutionParams {
  tenant_id: string;
  workflow_id: string;
  workflow_version_id: string;
  request_source: RequestSource;
  parent_execution_id?: string | null;
  execution_mode?: ExecutionMode;
}

export async function createExecution(db: Db, params: CreateExecutionParams): Promise<string> {
  const id = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(executions)
      .values({
        tenant_id: params.tenant_id,
        workflow_id: params.workflow_id,
        workflow_version_id: params.workflow_version_id,
        status: "queued",
        request_source: params.request_source,
        execution_mode: params.execution_mode ?? "dev",
        parent_execution_id: params.parent_execution_id ?? null,
      })
      .returning({ id: executions.id });
    if (!row) throw new Error("executions insert returned no row");
    await writeEvent(tx, {
      tenant_id: params.tenant_id,
      channel: "execution.status",
      type: "execution.queued",
      payload: {
        execution_id: row.id,
        workflow_id: params.workflow_id,
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
    workflow_id: params.workflow_id,
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

export async function finalizeExecution(
  db: Db,
  tenant_id: string,
  execution_id: string,
  status: ExecutionStatus,
  result_storage_uri: string | null,
): Promise<void> {
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
      workflow_id = row.workflow_id;
      request_source = row.request_source ?? "api";
      if (row.started_at && row.finished_at) {
        duration_ms = row.finished_at.getTime() - row.started_at.getTime();
      }
    }
    await writeEvent(tx, {
      tenant_id,
      channel: "execution.status",
      type: `execution.${status}`,
      payload: { execution_id, status },
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
  const [row] = await db
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
  if (!row) throw new Error("execution_steps insert returned no row");
  return row.id;
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
  await db
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
    .where(eq(executionSteps.id, step_row_id));
}
