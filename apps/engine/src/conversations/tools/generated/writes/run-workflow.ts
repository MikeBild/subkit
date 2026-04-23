// run_workflow tool — executes a workflow synchronously in the tenant's
// dev environment (unless the caller opts into prod). Writes an audit
// entry on each attempt.

import { z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { conversations } from "../../../../db/schema/index.ts";
import { runExecution } from "../../../../execution/engine.ts";
import { withWorkflowExecution } from "../../../authoring-state.ts";
import { buildGateError, buildLifecyclePayload } from "../../authoring-contract.ts";
import type { ConversationTool } from "../../index.ts";

const Input = z
  .object({
    workflow_id: z.string().uuid().optional(),
    input: z.unknown().optional(),
    environment: z.enum(["dev", "prod"]).default("dev"),
  })
  .openapi("RunWorkflowToolInput");

export const runWorkflowTool: ConversationTool = {
  name: "run_workflow",
  description:
    "Execute a workflow synchronously by id. Records an audit entry. Default environment is `dev`.",
  inputSchema: Input,
  category: "tenant_write",
  async execute(ctx, rawArgs) {
    const args = Input.parse(rawArgs);
    const currentDraft = ctx.getDraft();
    const activeTarget = currentDraft.summary?.active_target ?? null;
    const workflowId =
      args.workflow_id ??
      (activeTarget?.kind === "workflow" && activeTarget.lifecycle_state === "persisted"
        ? activeTarget.id
        : null);
    if (!workflowId) {
      return {
        ok: false,
        data: buildGateError(currentDraft, {
          error_code: "workflow_not_persisted",
          message: "commit the workflow before running it from the conversation surface",
          recommended_mode: "workflow",
          stale_checkpoints: ["workflow_persisted"],
        }),
      };
    }
    const wf = await ctx.engineClient.workflows.get(workflowId);
    if (!wf) return { ok: false, data: { error: "workflow_not_found" } };
    if (
      activeTarget?.kind === "workflow" &&
      activeTarget.lifecycle_state === "draft_only" &&
      !args.workflow_id
    ) {
      return {
        ok: false,
        data: buildGateError(currentDraft, {
          error_code: "workflow_not_persisted",
          message: "commit the current workflow draft before running it",
          recommended_mode: "workflow",
          stale_checkpoints: ["workflow_persisted"],
        }),
      };
    }

    try {
      const result = await runExecution({
        db: ctx.db,
        tenant_id: ctx.tenant_id,
        source: { kind: "saved", workflow_id: workflowId },
        input: args.input ?? null,
        options: {
          request_source: "chat",
          trace_id: null,
          principal: null,
          execution_mode: args.environment,
        },
      });
      await ctx.engineClient.audit_write({
        resource_type: "execution",
        resource_id: result.execution_id,
        action: "conversation.run_workflow",
        result: result.status === "succeeded" ? "success" : "error",
        metadata: {
          conversation_id: ctx.conversation_id,
          workflow_id: workflowId,
          environment: args.environment,
          final_status: result.status,
        },
      });
      await ctx.db
        .update(conversations)
        .set({
          target_workflow_id: workflowId,
          updated_at: new Date(),
        })
        .where(eq(conversations.id, ctx.conversation_id));
      // Surface non-fatal warnings (unresolved identifiers in transform
      // expressions, schema drift signals) so the LLM / operator sees
      // them next to the output. The execution still succeeded — the
      // warning is an FYI that will become an auto-repair candidate.
      const hasWarnings = (result.warnings?.length ?? 0) > 0;
      const diagnosisAvailable = hasWarnings || result.status !== "succeeded";
      const nextDraft = withWorkflowExecution(currentDraft, {
        execution_id: result.execution_id,
        workflow_id: workflowId,
        workflow_version_id: wf.current_version_id,
        status: result.status,
        environment: args.environment,
        warnings_count: result.warnings?.length ?? 0,
        recorded_at: new Date().toISOString(),
        diagnosis_available: diagnosisAvailable,
      });
      await ctx.setDraft(nextDraft);
      return {
        ok: result.status === "succeeded",
        data: buildLifecyclePayload(nextDraft, {
          execution_id: result.execution_id,
          workflow_id: workflowId,
          workflow_version_id: wf.current_version_id,
          workflow_version: wf.current_version,
          status: result.status,
          output: result.output,
          error: result.error,
          diagnosis_available: diagnosisAvailable,
          recommended_next_tool: diagnosisAvailable ? "diagnose_latest_execution" : null,
          ...(hasWarnings ? { warnings: result.warnings } : {}),
        }),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.engineClient.audit_write({
        resource_type: "workflow",
        resource_id: workflowId,
        action: "conversation.run_workflow",
        result: "error",
        reason: msg,
        metadata: { conversation_id: ctx.conversation_id },
      });
      return {
        ok: false,
        data: buildGateError(currentDraft, {
          error_code: "run_failed",
          message: msg,
          recommended_mode: "execution",
        }),
      };
    }
  },
};
