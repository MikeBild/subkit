import { z } from "@hono/zod-openapi";
import { and, asc, eq } from "drizzle-orm";
import { executionSteps } from "../../db/schema/index.ts";
import { buildScopeAtStep } from "../../workflows/scope-shape.ts";
import { withWorkflowDiagnosis } from "../authoring-state.ts";
import { buildGateError, buildLifecyclePayload } from "./authoring-contract.ts";
import type { ConversationTool, ToolResult } from "./index.ts";
import { truncateForLlm } from "./truncate.ts";

const inputSchema = z
  .object({
    execution_id: z.string().uuid().optional(),
  })
  .openapi("DiagnoseLatestExecutionToolInput");

function summarizeReason(status: string, warningCount: number, stepCount: number): string {
  if (status !== "succeeded") {
    return `Execution finished with status ${status}; inspect the failing steps before editing the workflow.`;
  }
  if (warningCount > 0) {
    return `Execution succeeded with ${warningCount} warning${warningCount === 1 ? "" : "s"} across ${stepCount} step${stepCount === 1 ? "" : "s"}.`;
  }
  return `Execution succeeded across ${stepCount} step${stepCount === 1 ? "" : "s"} with no warnings.`;
}

export const diagnoseLatestExecutionTool: ConversationTool = {
  name: "diagnose_latest_execution",
  description:
    "Inspect the latest execution with step-level previews and warnings so the next edit is grounded in the real runtime output.",
  inputSchema,
  category: "draft_write",
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const currentDraft = ctx.getDraft();
    const executionId =
      args.execution_id ?? currentDraft.summary?.latest_execution?.execution_id ?? null;
    if (!executionId) {
      return {
        ok: false,
        data: buildGateError(currentDraft, {
          error_code: "execution_missing",
          message: "run a workflow first, or provide an execution_id to diagnose",
          recommended_mode: "execution",
        }),
      };
    }
    const execution = await ctx.engineClient.executions.get(executionId);
    if (!execution) {
      return {
        ok: false,
        data: buildGateError(currentDraft, {
          error_code: "execution_not_found",
          message: "execution not found in the current tenant",
          recommended_mode: "execution",
        }),
      };
    }
    const rows = await ctx.db
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
        and(
          eq(executionSteps.tenant_id, ctx.tenant_id),
          eq(executionSteps.execution_id, executionId),
        ),
      )
      .orderBy(asc(executionSteps.step_index), asc(executionSteps.started_at));

    const warning_sources: Array<{ step_key: string; code: string; identifier: string | null }> =
      [];
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
      // scope_at_step on each step makes the diagnosis prompt
      // ground the repair LLM in real shapes rather than docs. Pre-
      // fix the LLM proposed patches against an imagined envelope
      // and the next dry-run revealed the same bug.
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

    const diagnosis = {
      execution_id: execution.id,
      recorded_at: new Date().toISOString(),
      reason: summarizeReason(execution.status, warning_sources.length, steps.length),
      warning_sources,
      steps,
    };
    const nextDraft = withWorkflowDiagnosis(currentDraft, diagnosis);
    await ctx.setDraft(nextDraft);

    return {
      ok: true,
      data: buildLifecyclePayload(nextDraft, {
        execution: {
          execution_id: execution.id,
          workflow_id: execution.workflow_id,
          workflow_version_id: execution.workflow_version_id,
          status: execution.status,
          environment: execution.execution_mode,
        },
        diagnosis,
      }),
    };
  },
};
