import { and, asc, desc, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Executor } from "../db/client.ts";
import { executionSteps, executions } from "../db/schema/index.ts";
import { executionVisibilityFilter } from "./execution-owner.ts";

export type ExecutionRow = typeof executions.$inferSelect;

function visibleExecution(tenant_id: string, execution_id: string, principal: ResolvedPrincipal) {
  return and(
    eq(executions.tenant_id, tenant_id),
    eq(executions.id, execution_id),
    executionVisibilityFilter(principal),
  );
}

export async function findVisibleExecution(
  db: Executor,
  tenant_id: string,
  execution_id: string,
  principal: ResolvedPrincipal,
): Promise<ExecutionRow | undefined> {
  const [row] = await db
    .select()
    .from(executions)
    .where(visibleExecution(tenant_id, execution_id, principal))
    .limit(1);
  return row;
}

export async function findVisibleExecutionPayload(
  db: Executor,
  tenant_id: string,
  execution_id: string,
  principal: ResolvedPrincipal,
): Promise<{ input: unknown; result: unknown } | undefined> {
  const [row] = await db
    .select({ input: executions.input, result: executions.sensitive_result })
    .from(executions)
    .where(visibleExecution(tenant_id, execution_id, principal))
    .limit(1);
  return row;
}

export async function findVisibleExecutionHead(
  db: Executor,
  tenant_id: string,
  execution_id: string,
  principal: ResolvedPrincipal,
) {
  const [row] = await db
    .select({
      id: executions.id,
      tenant_id: executions.tenant_id,
      status: executions.status,
      workflow_id: executions.workflow_id,
      input: executions.input,
    })
    .from(executions)
    .where(visibleExecution(tenant_id, execution_id, principal))
    .limit(1);
  return row;
}

export async function latestVisibleExecutionId(
  db: Executor,
  tenant_id: string,
  principal: ResolvedPrincipal,
  workflow_id: string | null,
): Promise<string | null> {
  const rows = await db
    .select({ id: executions.id })
    .from(executions)
    .where(
      and(
        eq(executions.tenant_id, tenant_id),
        executionVisibilityFilter(principal),
        ...(workflow_id ? [eq(executions.workflow_id, workflow_id)] : []),
      ),
    )
    .orderBy(desc(executions.created_at))
    .limit(1);
  return rows[0]?.id ?? null;
}

export async function findExecutionSummary(db: Executor, tenant_id: string, execution_id: string) {
  const [row] = await db
    .select({
      id: executions.id,
      workflow_id: executions.workflow_id,
      workflow_version_id: executions.workflow_version_id,
      status: executions.status,
      execution_mode: executions.execution_mode,
    })
    .from(executions)
    .where(and(eq(executions.tenant_id, tenant_id), eq(executions.id, execution_id)))
    .limit(1);
  return row;
}

export async function listExecutionStepsForDiagnosis(
  db: Executor,
  tenant_id: string,
  execution_id: string,
) {
  return db
    .select({
      step_key: executionSteps.step_key,
      kind: executionSteps.kind,
      status: executionSteps.status,
      duration_ms: executionSteps.duration_ms,
      output_preview: executionSteps.output_preview,
      error: executionSteps.error,
      request_meta: executionSteps.request_meta,
      credential_snapshots: executionSteps.credential_snapshots,
    })
    .from(executionSteps)
    .where(
      and(eq(executionSteps.tenant_id, tenant_id), eq(executionSteps.execution_id, execution_id)),
    )
    .orderBy(asc(executionSteps.step_index), asc(executionSteps.started_at));
}

export async function findExecutionStepByKey(
  db: Executor,
  tenant_id: string,
  execution_id: string,
  step_key: string,
) {
  const [row] = await db
    .select({
      id: executionSteps.id,
      step_key: executionSteps.step_key,
      kind: executionSteps.kind,
      status: executionSteps.status,
      output_preview: executionSteps.output_preview,
      result_storage_uri: executionSteps.result_storage_uri,
      result_sha256: executionSteps.result_sha256,
      request_meta: executionSteps.request_meta,
      credential_snapshots: executionSteps.credential_snapshots,
      duration_ms: executionSteps.duration_ms,
      retry_count: executionSteps.retry_count,
      error: executionSteps.error,
    })
    .from(executionSteps)
    .where(
      and(
        eq(executionSteps.tenant_id, tenant_id),
        eq(executionSteps.execution_id, execution_id),
        eq(executionSteps.step_key, step_key),
      ),
    )
    .limit(1);
  return row;
}

export async function listExecutionStepStatuses(
  db: Executor,
  tenant_id: string,
  execution_id: string,
): Promise<Array<{ step_key: string; status: string }>> {
  return db
    .select({ step_key: executionSteps.step_key, status: executionSteps.status })
    .from(executionSteps)
    .where(
      and(eq(executionSteps.tenant_id, tenant_id), eq(executionSteps.execution_id, execution_id)),
    );
}

export async function latestSucceededStepPreview(
  db: Executor,
  tenant_id: string,
  workflow_id: string,
  step_key: string,
  principal: ResolvedPrincipal,
) {
  const [row] = await db
    .select({
      output_preview: executionSteps.output_preview,
      status: executionSteps.status,
      input: executions.input,
      result: executions.sensitive_result,
    })
    .from(executionSteps)
    .innerJoin(executions, eq(executions.id, executionSteps.execution_id))
    .where(
      and(
        eq(executionSteps.tenant_id, tenant_id),
        eq(executions.workflow_id, workflow_id),
        eq(executions.tenant_id, tenant_id),
        executionVisibilityFilter(principal),
        eq(executionSteps.step_key, step_key),
        eq(executionSteps.status, "succeeded"),
      ),
    )
    .orderBy(desc(executionSteps.finished_at), desc(executions.created_at))
    .limit(1);
  return row;
}
