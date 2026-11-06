import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { AuditAction, type AuditActorType, auditAwait } from "../audit/index.ts";
import { assertInsertRow } from "../db/assert-insert.ts";
import { lockCatalogVocabulary } from "../db/catalog-vocabulary.ts";
import type { Db, Executor } from "../db/client.ts";
import { writeEvent } from "../db/events.ts";
import { executionSteps, executions, workflowVersions } from "../db/schema/index.ts";
import { getContext } from "../logging/context.ts";
import { logger } from "../logging/logger.ts";
import { recordExecutionTerminal } from "../observability/instrumentation.ts";
import { RequestSourceSchema } from "../observability/service-metadata.ts";
import type { ExecutionAuthorizationContext } from "./authorization-context.ts";
import {
  markBillableStep,
  settleExecutionGuards,
  takeBillableDispatches,
} from "./caller-budget.ts";
import { type CallerContext, CallerContextSchema } from "./caller-context.ts";
import {
  type CallerOrigin,
  resolveExecutionCallerActor,
  resolveExecutionCallerOrigin,
} from "./caller-origin.ts";
import {
  type ExecutionOutcome,
  NON_TERMINAL_EXECUTION_STATUSES,
  type OutcomeTransition,
  outcomeTransition,
  transitionSources,
} from "./core/status.ts";
import {
  isSensitivePayload,
  protectExecutionPayload,
  sensitiveFailure,
  sensitiveRequestMeta,
} from "./sensitive-payload.ts";
import {
  type ExecutionMode,
  type ExecutionSourceKind,
  type ExecutionStatus,
  hasHeldOutput,
  type RequestSource,
  type StepResult,
  type StepStatus,
} from "./types.ts";

export interface CreateExecutionParams {
  id?: string;
  execution_privacy?: "sensitive" | undefined;
  tenant_id: string;
  caller_context?: CallerContext | null;
  caller_origin?: CallerOrigin;
  authorization_context?: ExecutionAuthorizationContext | null;
  execution_authority_id?: string | null;
  tool_approval_id?: string | null;
  hold_writes?: boolean;
  purpose?: "authority_preparation";
  workflow_id: string | null;
  workflow_version_id: string | null;
  source_kind: ExecutionSourceKind;
  source_ref: Record<string, unknown> | null;
  request_source: RequestSource;
  parent_execution_id?: string | null;
  authority_link?: { root_execution_id: string; call_path: string[] } | null;
  execution_mode?: ExecutionMode;
  input?: unknown;
  idempotency_key?: string | null;
}

export function isIdempotencyConflict(err: unknown): boolean {
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
  const caller =
    params.caller_context == null ? null : CallerContextSchema.parse(params.caller_context);
  if (caller && caller.tenantId !== params.tenant_id)
    throw Object.assign(new Error("caller_tenant_mismatch"), { code: "caller_tenant_mismatch" });
  const callerOrigin = resolveExecutionCallerOrigin(params.tenant_id, caller, params.caller_origin);
  const originSource = RequestSourceSchema.safeParse(getContext().audit_origin_source);
  const auditTraceId = getContext().audit_trace_id ?? null;
  const id = await db.transaction(async (tx) => {
    await lockCatalogVocabulary(tx, params.tenant_id);
    const [version] = params.workflow_version_id
      ? await tx
          .select({ dag: workflowVersions.dag })
          .from(workflowVersions)
          .where(
            and(
              eq(workflowVersions.tenant_id, params.tenant_id),
              eq(workflowVersions.id, params.workflow_version_id),
            ),
          )
          .limit(1)
      : [];
    const sensitive =
      params.execution_privacy === "sensitive" ||
      (version?.dag as { execution_privacy?: string } | undefined)?.execution_privacy ===
        "sensitive";
    const executionId = params.id ?? randomUUID();
    const [row] = await tx
      .insert(executions)
      .values({
        id: executionId,
        tenant_id: params.tenant_id,
        execution_authority_id: params.execution_authority_id ?? null,
        tool_approval_id: params.tool_approval_id ?? null,
        hold_writes: params.hold_writes ?? false,
        workflow_id: params.workflow_id,
        workflow_version_id: params.workflow_version_id,
        source_kind: params.source_kind,
        source_ref:
          sensitive && params.source_ref
            ? protectExecutionPayload(params.source_ref, params.tenant_id, executionId, "source")
            : params.source_ref,
        caller_context: caller,
        caller_origin: callerOrigin,
        authorization_context: params.authorization_context ?? null,
        status: "queued",
        request_source: params.request_source,
        origin_source: originSource.success ? originSource.data : null,
        audit_trace_id: auditTraceId,
        execution_mode: params.execution_mode ?? "dev",
        parent_execution_id: params.parent_execution_id ?? null,
        authority_root_execution_id: params.authority_link?.root_execution_id ?? null,
        authority_call_path: params.authority_link?.call_path ?? null,
        input: sensitive
          ? protectExecutionPayload(params.input, params.tenant_id, executionId, "input")
          : (params.input ?? null),
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
    await auditAwait(
      {
        tenant_id: params.tenant_id,
        ...resolveExecutionCallerActor(params.tenant_id, caller, callerOrigin),
        action: AuditAction.EXECUTION_QUEUED,
        resource_type: "execution",
        resource_id: row.id,
        result: "success",
        metadata: {
          request_source: params.request_source,
          source_kind: params.source_kind,
          workflow_id: params.workflow_id,
          workflow_version_id: params.workflow_version_id,
          execution_mode: params.execution_mode ?? "dev",
          hold_writes: Boolean(params.hold_writes),
          ...(params.purpose ? { purpose: params.purpose } : {}),
          ...(params.execution_authority_id
            ? { execution_authority_id: params.execution_authority_id }
            : {}),
          ...(params.parent_execution_id
            ? { parent_execution_id: params.parent_execution_id }
            : {}),
        },
      },
      tx,
    );
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

export type OutputContractVerdict = "passed" | "violated" | "none";

export interface ExecutionFailureDetail {
  step_id: string | null;
  error_code: string;
  error_message: string;
  connector?: RefusedConnector;
}

export interface RefusedConnector {
  connector_id: string | null;
  reason: string;
}

const NON_TERMINAL_STATUSES: ExecutionStatus[] = [...NON_TERMINAL_EXECUTION_STATUSES];

export interface TerminalizeExecutionParams {
  tenant_id: string;
  execution_id: string;
  status: ExecutionStatus;
  finished_at: Date;
  failure: ExecutionFailureDetail | null;
  expected_statuses?: readonly ExecutionStatus[];
  output_contract?: OutputContractVerdict;
  result_storage_uri?: string | null;
  result_sha256?: string | null;
  sensitive_result?: unknown;
}

export interface TerminalizedExecutionRow {
  id: string;
  workflow_id: string | null;
  request_source: string | null;
  started_at: Date | null;
  finished_at: Date | null;
}

export async function terminalizeExecutionRow(
  db: Executor,
  params: TerminalizeExecutionParams,
): Promise<TerminalizedExecutionRow | null> {
  const sources = transitionSources(
    params.status,
    params.expected_statuses ?? NON_TERMINAL_STATUSES,
  );
  if (sources.length === 0) return null;
  const [row] = await db
    .update(executions)
    .set({
      status: params.status,
      finished_at: params.finished_at,
      failure: params.failure,
      ...(params.output_contract !== undefined ? { output_contract: params.output_contract } : {}),
      ...(params.result_storage_uri !== undefined
        ? { result_storage_uri: params.result_storage_uri }
        : {}),
      ...(params.result_sha256 !== undefined ? { result_sha256: params.result_sha256 } : {}),
      ...(params.sensitive_result !== undefined
        ? { sensitive_result: params.sensitive_result }
        : {}),
    })
    .where(
      and(
        eq(executions.tenant_id, params.tenant_id),
        eq(executions.id, params.execution_id),
        inArray(executions.status, sources),
      ),
    )
    .returning({
      id: executions.id,
      workflow_id: executions.workflow_id,
      request_source: executions.request_source,
      started_at: executions.started_at,
      finished_at: executions.finished_at,
    });
  return row ?? null;
}

export interface FinalizeExecutionDetails {
  result_storage_uri?: string | null;
  failure?: ExecutionFailureDetail | null;
  result_sha256?: string | null;
  output_contract?: OutputContractVerdict;
  sensitive_result?: unknown;
}

export function finalizeExecution(
  db: Db,
  tenant_id: string,
  execution_id: string,
  outcome: ExecutionOutcome,
  details: FinalizeExecutionDetails = {},
): Promise<void> {
  return applyFinalization(db, tenant_id, execution_id, outcomeTransition(outcome), details);
}

async function applyFinalization(
  db: Db,
  tenant_id: string,
  execution_id: string,
  transition: OutcomeTransition,
  details: FinalizeExecutionDetails,
): Promise<void> {
  const { status, sources: expectedStatuses, refused } = transition;
  const result_storage_uri = details.result_storage_uri ?? null;
  const output_contract = details.output_contract ?? "none";
  const sensitive_result = details.sensitive_result;
  let failure = details.failure ?? null;
  let result_sha256 = details.result_sha256 ?? null;
  let workflow_id: string | null = null;
  let request_source: string = "api";
  let duration_ms: number | null = null;
  let applied = false;
  await db.transaction(async (tx) => {
    const [persisted] = await tx
      .select({ input: executions.input })
      .from(executions)
      .where(and(eq(executions.tenant_id, tenant_id), eq(executions.id, execution_id)))
      .limit(1);
    if (isSensitivePayload(persisted?.input)) {
      failure = failure
        ? {
            step_id: failure.step_id,
            error_code: sensitiveFailure(failure.error_code).code,
            error_message: sensitiveFailure().message,
          }
        : null;
      result_sha256 = null;
    }
    const row = await terminalizeExecutionRow(tx, {
      tenant_id,
      execution_id,
      status,
      finished_at: new Date(),
      failure: failure ?? null,
      expected_statuses: expectedStatuses,
      output_contract,
      result_storage_uri,
      result_sha256,
      ...(isSensitivePayload(persisted?.input) && sensitive_result !== undefined
        ? {
            sensitive_result: protectExecutionPayload(
              sensitive_result,
              tenant_id,
              execution_id,
              "result",
            ),
          }
        : {}),
    });
    if (!row) {
      return;
    }
    applied = true;
    const settlement = await settleExecutionGuards(tx, {
      tenant_id,
      execution_id,
      status: refused ? "failed" : status,
      output: sensitive_result,
    });
    const resultObject =
      sensitive_result && typeof sensitive_result === "object" && !Array.isArray(sensitive_result)
        ? (sensitive_result as Record<string, unknown>)
        : null;
    if (settlement.attach && resultObject && isSensitivePayload(persisted?.input)) {
      await tx
        .update(executions)
        .set({
          sensitive_result: protectExecutionPayload(
            { ...resultObject, [settlement.attach.key]: settlement.attach.usage },
            tenant_id,
            execution_id,
            "result",
          ),
        })
        .where(and(eq(executions.tenant_id, tenant_id), eq(executions.id, execution_id)));
    }
    workflow_id = row.workflow_id ?? null;
    request_source = row.request_source ?? "api";
    if (row.started_at && row.finished_at) {
      duration_ms = row.finished_at.getTime() - row.started_at.getTime();
    }
    await writeEvent(tx, {
      tenant_id,
      channel: "execution.status",
      type: transition.event_type,
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

export const GOVERNANCE_REFUSALS: ReadonlySet<string> = new Set([
  "request_outside_declared_boundary",
  "execution_authority_changed",
  "execution_boundary_mismatch",
  "execution_authority_required",
  "execution_authority_unavailable",
  "authority_redirect_denied",
]);

export async function finalizeStepRow(
  db: Db,
  step_row_id: string,
  status: StepStatus,
  result: StepResult,
  options: {
    tenant_id: string;
    output_preview: unknown | null;
    result_preview: string | null;
    result_storage_uri: string | null;
    result_sha256?: string | null;
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    const [persisted] = await tx
      .select({
        input: executions.input,
        tenant: executions.tenant_id,
        execution: executions.id,
        caller_context: executions.caller_context,
        caller_origin: executions.caller_origin,
        request_source: executions.request_source,
        workflow_version_id: executions.workflow_version_id,
        guard_bucket: executions.guard_bucket,
        guard_unit_key: executions.guard_unit_key,
      })
      .from(executionSteps)
      .innerJoin(
        executions,
        and(
          eq(executions.id, executionSteps.execution_id),
          eq(executions.tenant_id, executionSteps.tenant_id),
        ),
      )
      .where(
        and(eq(executionSteps.tenant_id, options.tenant_id), eq(executionSteps.id, step_row_id)),
      )
      .limit(1);
    if (persisted && isSensitivePayload(persisted.input)) {
      result = {
        ...result,
        request_meta: sensitiveRequestMeta(result.request_meta),
        error: result.error ? sensitiveFailure(result.error.code) : null,
      };
      options = {
        ...options,
        output_preview: protectExecutionPayload(
          options.output_preview,
          persisted.tenant,
          persisted.execution,
          `step:${step_row_id}`,
        ),
        result_preview: null,
        result_sha256: null,
      };
    }
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
        held: hasHeldOutput(result),
      })
      .where(
        and(
          eq(executionSteps.tenant_id, options.tenant_id),
          eq(executionSteps.id, step_row_id),
          eq(executionSteps.status, "running"),
        ),
      )
      .returning({
        tenant_id: executionSteps.tenant_id,
        execution_id: executionSteps.execution_id,
        step_key: executionSteps.step_key,
        step_index: executionSteps.step_index,
        kind: executionSteps.kind,
      });
    const dispatched = takeBillableDispatches(step_row_id);
    const row = updated[0];
    if (!row) return;
    if (status === "succeeded" && persisted?.guard_unit_key) {
      await markBillableStep(tx, {
        tenant_id: row.tenant_id,
        execution_id: row.execution_id,
        step_key: row.step_key,
        output: result.output,
        row: persisted,
        dispatched,
      });
    }
    if (result.error?.code && GOVERNANCE_REFUSALS.has(result.error.code)) {
      await auditAwait(
        {
          tenant_id: row.tenant_id,
          ...resolveExecutionCallerActor(
            row.tenant_id,
            persisted?.caller_context,
            persisted?.caller_origin,
          ),
          action: AuditAction.EXECUTION_BOUNDARY_REFUSED,
          resource_type: "execution",
          resource_id: row.execution_id,
          result: "denied",
          reason: result.error.code,
          metadata: {
            stage: "dispatch",
            request_source: persisted?.request_source ?? null,
            step_key: row.step_key,
            step_index: row.step_index,
            kind: row.kind,
            detail: String(result.error.message ?? "").slice(0, 500),
            ...(result.error.reason ? { refusal_reason: result.error.reason } : {}),
          },
        },
        tx,
      );
    }
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
