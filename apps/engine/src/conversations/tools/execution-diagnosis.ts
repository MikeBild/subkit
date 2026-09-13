// Shared whole-execution diagnosis builder.
//
// Reads a finished execution and its steps (tenant-scoped) and assembles
// the step-level diagnosis — status, durations, warnings, truncated
// output previews, scope shapes — that both `inspect_execution`
// (tenant_read, chat + MCP) and `diagnose_latest_execution` (draft_write,
// chat) report. Keeping the read in one place means the two tools never
// drift apart.

import { and, asc, eq } from "drizzle-orm";

import type { Db } from "../../db/client.ts";
import { executions, executionSteps } from "../../db/schema/index.ts";
import { buildScopeAtStep } from "../../workflows/scope-shape.ts";
import type { LatestDiagnosisSummary } from "../types.ts";
import { truncateForLlm } from "./truncate.ts";

/** Execution-level summary returned alongside the diagnosis. */
export interface ExecutionSummary {
  execution_id: string;
  workflow_id: string | null;
  workflow_version_id: string | null;
  status: string;
  environment: "dev" | "prod";
}

export type ExecutionDiagnosisResult =
  | { found: true; execution: ExecutionSummary; diagnosis: LatestDiagnosisSummary }
  | { found: false };

function summarizeReason(status: string, warningCount: number, stepCount: number): string {
  if (status !== "succeeded") {
    return `Execution finished with status ${status}; inspect the failing steps before editing the workflow.`;
  }
  if (warningCount > 0) {
    return `Execution succeeded with ${warningCount} warning${warningCount === 1 ? "" : "s"} across ${stepCount} step${stepCount === 1 ? "" : "s"}.`;
  }
  return `Execution succeeded across ${stepCount} step${stepCount === 1 ? "" : "s"} with no warnings.`;
}

/**
 * Build the step-level diagnosis for one execution. Every query is
 * filtered on `tenant_id`, so a leaked execution id from another tenant
 * resolves to `{ found: false }`.
 */
export async function buildExecutionDiagnosis(
  db: Db,
  tenant_id: string,
  executionId: string,
): Promise<ExecutionDiagnosisResult> {
  const execRows = await db
    .select({
      id: executions.id,
      workflow_id: executions.workflow_id,
      workflow_version_id: executions.workflow_version_id,
      status: executions.status,
      execution_mode: executions.execution_mode,
    })
    .from(executions)
    .where(and(eq(executions.tenant_id, tenant_id), eq(executions.id, executionId)))
    .limit(1);
  const execution = execRows[0];
  if (!execution) return { found: false };

  const rows = await db
    .select({
      step_key: executionSteps.step_key,
      kind: executionSteps.kind,
      status: executionSteps.status,
      duration_ms: executionSteps.duration_ms,
      output_preview: executionSteps.output_preview,
      error: executionSteps.error,
      request_meta: executionSteps.request_meta,
    })
    .from(executionSteps)
    .where(
      and(eq(executionSteps.tenant_id, tenant_id), eq(executionSteps.execution_id, executionId)),
    )
    .orderBy(asc(executionSteps.step_index), asc(executionSteps.started_at));

  const warning_sources: Array<{ step_key: string; code: string; identifier: string | null }> = [];
  const steps = rows.map((row) => {
    const previewRecord =
      row.output_preview &&
      typeof row.output_preview === "object" &&
      !Array.isArray(row.output_preview)
        ? (row.output_preview as Record<string, unknown>)
        : null;
    const rawWarnings = Array.isArray(previewRecord?.warnings) ? previewRecord.warnings : [];
    for (const warning of rawWarnings) {
      if (
        warning &&
        typeof warning === "object" &&
        typeof (warning as { code?: unknown }).code === "string"
      ) {
        warning_sources.push({
          step_key: row.step_key,
          code: (warning as { code: string }).code,
          identifier:
            typeof (warning as { identifier?: unknown }).identifier === "string"
              ? ((warning as { identifier?: string }).identifier ?? null)
              : null,
        });
      }
    }
    const previewValue =
      previewRecord && Object.hasOwn(previewRecord, "value")
        ? previewRecord.value
        : row.output_preview;
    const truncatedPreview = truncateForLlm(previewValue);
    // scope_at_step on each step grounds the next edit in the real
    // runtime shape rather than an imagined envelope.
    const scope =
      previewValue !== undefined && previewValue !== null ? buildScopeAtStep(previewValue) : null;
    return {
      step_key: row.step_key,
      kind: row.kind,
      status: row.status,
      duration_ms: row.duration_ms ?? null,
      ...(previewValue !== undefined ? { output_preview: truncatedPreview.data } : {}),
      ...(scope ? { scope_at_step: scope } : {}),
      ...(row.error !== null ? { error: row.error } : {}),
      ...(row.request_meta !== null ? { request_meta: row.request_meta } : {}),
    };
  });

  const diagnosis: LatestDiagnosisSummary = {
    execution_id: execution.id,
    recorded_at: new Date().toISOString(),
    reason: summarizeReason(execution.status, warning_sources.length, steps.length),
    warning_sources,
    steps,
  };

  return {
    found: true,
    execution: {
      execution_id: execution.id,
      workflow_id: execution.workflow_id,
      workflow_version_id: execution.workflow_version_id,
      status: execution.status,
      environment: execution.execution_mode,
    },
    diagnosis,
  };
}
