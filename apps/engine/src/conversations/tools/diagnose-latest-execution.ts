import { z } from "@hono/zod-openapi";
import { isSensitivePayload } from "../../execution/sensitive-payload.ts";
import { findVisibleExecutionPayload } from "../../execution/visible-reads.ts";
import { withWorkflowDiagnosis } from "../authoring-state/index.ts";
import { buildGateError, buildLifecyclePayload } from "./authoring-contract.ts";
import { buildExecutionDiagnosis } from "./execution-diagnosis.ts";
import type { ConversationTool, ToolResult } from "./index.ts";
import { sensitiveExecutionUnsupported } from "./sensitive-envelope.ts";

const inputSchema = z
  .object({
    execution_id: z.string().uuid().optional(),
  })
  .openapi("DiagnoseLatestExecutionToolInput");

export const diagnoseLatestExecutionTool: ConversationTool = {
  name: "diagnose_latest_execution",
  description:
    "Inspect the latest execution with step-level previews and warnings so the next edit is grounded in the real runtime output.",
  inputSchema,
  category: "draft_write",
  authoring_resource: "workflow",
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
    if (!ctx.principal) return { ok: false, error_code: "principal_required" };
    const visible = await findVisibleExecutionPayload(
      ctx.db,
      ctx.tenant_id,
      executionId,
      ctx.principal,
    );
    if (!visible) return { ok: false, error_code: "execution_not_found" };
    if (isSensitivePayload(visible.input) || isSensitivePayload(visible.result))
      return sensitiveExecutionUnsupported(
        "This execution carries sensitive data, so its contents stay out of chat.",
      );
    const result = await buildExecutionDiagnosis(ctx.db, ctx.tenant_id, executionId);
    if (!result.found) {
      return {
        ok: false,
        data: buildGateError(currentDraft, {
          error_code: "execution_not_found",
          message: "execution not found in the current tenant",
          recommended_mode: "execution",
        }),
      };
    }
    const { execution, diagnosis } = result;
    const nextDraft = withWorkflowDiagnosis(currentDraft, diagnosis);
    await ctx.setDraft(nextDraft);

    return {
      ok: true,
      data: buildLifecyclePayload(nextDraft, {
        execution: {
          execution_id: execution.execution_id,
          workflow_id: execution.workflow_id,
          workflow_version_id: execution.workflow_version_id,
          status: execution.status,
          environment: execution.environment,
        },
        diagnosis,
      }),
    };
  },
};
