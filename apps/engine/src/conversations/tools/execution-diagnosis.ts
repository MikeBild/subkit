import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { executionSteps, executions } from "../../db/schema/index.ts";
import { HELD_PREVIEW_WARNING_CODE } from "../../execution/types.ts";
import { buildScopeAtStep } from "../../workflows/scope-shape.ts";
import type { LatestDiagnosisSummary } from "../types.ts";
import { truncateForLlm } from "./truncate.ts";

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

function summarizeReason(
  status: string,
  warningCount: number,
  stepCount: number,
  failedCount: number,
  skippedCount: number,
  heldCount: number,
): string {
  if (failedCount > 0) {
    return `Execution finished with status ${status}, but ${failedCount} step${failedCount === 1 ? "" : "s"} failed. The workflow continued after errors; this is not a successful verification. Inspect the failing steps.`;
  }
  if (status !== "succeeded") {
    return `Execution finished with status ${status}; inspect the failing steps before editing the workflow.`;
  }
  if (heldCount > 0) {
    return `Preview completed with held writes in ${heldCount} step${heldCount === 1 ? "" : "s"}. Those actions were not performed. This is not evidence of live execution or permission for automatic runs.`;
  }
  if (skippedCount > 0) {
    return `Execution succeeded with ${skippedCount} skipped step${skippedCount === 1 ? "" : "s"} and ${warningCount} warnings across ${stepCount} steps. Skipped actions were not verified or performed; inspect their reasons before claiming readiness.`;
  }
  if (warningCount > 0) {
    return `Execution succeeded with ${warningCount} warning${warningCount === 1 ? "" : "s"} across ${stepCount} step${stepCount === 1 ? "" : "s"}.`;
  }
  return `Execution succeeded across ${stepCount} step${stepCount === 1 ? "" : "s"} with no warnings.`;
}

export interface StepWarningSource {
  step_key: string;
  code: string;
  identifier: string | null;
}

function previewRecordOf(preview: unknown): Record<string, unknown> | null {
  return preview && typeof preview === "object" && !Array.isArray(preview)
    ? (preview as Record<string, unknown>)
    : null;
}

export function stepWarningSources(
  rows: ReadonlyArray<{ step_key: string; output_preview: unknown; request_meta: unknown }>,
): StepWarningSource[] {
  const sources: StepWarningSource[] = [];
  for (const row of rows) {
    const previewRecord = previewRecordOf(row.output_preview);
    const rawWarnings = Array.isArray(previewRecord?.warnings) ? previewRecord.warnings : [];
    for (const warning of rawWarnings) {
      if (
        warning &&
        typeof warning === "object" &&
        typeof (warning as { code?: unknown }).code === "string"
      ) {
        sources.push({
          step_key: row.step_key,
          code: (warning as { code: string }).code,
          identifier:
            typeof (warning as { identifier?: unknown }).identifier === "string"
              ? ((warning as { identifier?: string }).identifier ?? null)
              : null,
        });
      }
    }
    const meta = row.request_meta as { extras?: { held?: unknown } } | null;
    if (
      meta?.extras?.held === true &&
      !sources.some(
        (warning) =>
          warning.step_key === row.step_key && warning.code === HELD_PREVIEW_WARNING_CODE,
      )
    ) {
      sources.push({ step_key: row.step_key, code: HELD_PREVIEW_WARNING_CODE, identifier: null });
    }
  }
  return sources;
}

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

  const warning_sources = stepWarningSources(rows);
  const steps = rows.map((row) => {
    const previewRecord = previewRecordOf(row.output_preview);
    const previewValue =
      previewRecord && Object.hasOwn(previewRecord, "value")
        ? previewRecord.value
        : row.output_preview;
    const truncatedPreview = truncateForLlm(previewValue);
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
    reason: summarizeReason(
      execution.status,
      warning_sources.length,
      steps.length,
      steps.filter((step) => ["failed", "timed_out", "aborted"].includes(step.status)).length,
      steps.filter((step) => step.status === "skipped").length,
      warning_sources.filter((warning) => warning.code === HELD_PREVIEW_WARNING_CODE).length,
    ),
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
