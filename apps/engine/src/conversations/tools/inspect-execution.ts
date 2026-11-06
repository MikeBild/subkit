import { z } from "@hono/zod-openapi";
import { executionStartTraceId } from "../../audit/index.ts";
import { describeExecutionEvidence, isSensitivePayload } from "../../execution/index.ts";
import {
  findVisibleExecutionPayload,
  latestVisibleExecutionId,
} from "../../execution/visible-reads.ts";
import { findWorkflowLabel } from "../../workflows/index.ts";
import { persistedWorkflowResource } from "../authoring-state/summary.ts";
import { buildExecutionDiagnosis } from "./execution-diagnosis.ts";
import type { ConversationTool, ToolContext } from "./index.ts";
import { sensitiveExecutionUnsupported } from "./sensitive-envelope.ts";

const Input = z
  .object({
    execution_id: z
      .string()
      .uuid()
      .optional()
      .describe(
        "Execution to inspect. Omit to inspect this conversation's run, else the bound workflow's most recent execution.",
      ),
  })
  .openapi("InspectExecutionToolInput");

type SelectedBy = "explicit" | "conversation_run" | "bound_workflow_latest" | "tenant_latest";

function boundWorkflowId(ctx: ToolContext): string | null {
  if (ctx.workflow_id) return ctx.workflow_id;
  const state = ctx.getDraft().state;
  return state ? (persistedWorkflowResource(state)?.id ?? null) : null;
}

async function latestExecutionId(ctx: ToolContext, workflowId: string | null) {
  if (!ctx.principal) return null;
  return latestVisibleExecutionId(ctx.db, ctx.tenant_id, ctx.principal, workflowId);
}

async function describeWorkflow(ctx: ToolContext, workflowId: string | null) {
  if (!workflowId) return { slug: null, name: null };
  const row = await findWorkflowLabel(ctx.db, ctx.tenant_id, workflowId);
  return { slug: row?.slug ?? null, name: row?.name ?? null };
}

export const inspectExecutionTool: ConversationTool = {
  name: "inspect_execution",
  description:
    "Inspect a completed execution with its structured `outcome` (kind, failed step, cause class, step counts, output-contract verdict) and step-level diagnosis — per-step status, duration, warnings, truncated output previews, and scope shapes — so the next edit is grounded in the real runtime output. Omit execution_id to inspect this conversation's run, or the bound workflow's most recent execution; the result's `inspected` names the execution and workflow it chose.",
  use_case:
    "Check why a run failed or warned, or see the actual per-step output shapes before authoring a transform. Available on both the chat and MCP surfaces.",
  important_notes: [
    "Without execution_id: the run this conversation was opened for, else the bound workflow's most recent execution. Only a conversation bound to no workflow falls back to the tenant's most recent execution.",
    "Check `inspected.workflow_slug` before acting on the result: it is the workflow the inspected run belongs to.",
    "Step output previews are truncated to fit the LLM context. For a single step's full (possibly offloaded) payload, use inspect_execution_step with include_full_payload:true.",
    "Refuses with execution_not_found when an explicit execution_id does not exist on this tenant, and no_executions when the bound workflow (or, unbound, the tenant) has run nothing yet.",
  ],
  inputSchema: Input,
  category: "tenant_read",
  permission: { action: "execution:read", resourceType: "execution" },
  async execute(ctx, rawArgs) {
    const args = Input.parse(rawArgs);
    if (!ctx.principal) return { ok: false, data: { error_code: "principal_required" } };
    let executionId = args.execution_id ?? null;
    let selectedBy: SelectedBy = "explicit";
    if (!executionId) {
      const bound = boundWorkflowId(ctx);
      const focused = ctx.getDraft().state?.latest_execution ?? null;
      if (focused && (!bound || focused.workflow_id === bound)) {
        executionId = focused.execution_id;
        selectedBy = "conversation_run";
      } else {
        executionId = await latestExecutionId(ctx, bound);
        selectedBy = bound ? "bound_workflow_latest" : "tenant_latest";
      }
      if (!executionId) {
        const workflow = await describeWorkflow(ctx, bound);
        return {
          ok: false,
          data: {
            error_code: "no_executions",
            message: bound
              ? `workflow ${workflow.slug ?? bound} has no executions to inspect — run it first, or pass an execution_id`
              : "this tenant has no executions to inspect — run a workflow first",
            ...(bound ? { workflow_id: bound, workflow_slug: workflow.slug } : {}),
          },
        };
      }
    }
    const visible = await findVisibleExecutionPayload(
      ctx.db,
      ctx.tenant_id,
      executionId,
      ctx.principal,
    );
    if (!visible) return { ok: false, data: { error_code: "execution_not_found" } };
    if (isSensitivePayload(visible.input))
      return sensitiveExecutionUnsupported(
        "This execution carries sensitive data, so its contents stay out of chat.",
      );
    const [result, row] = await Promise.all([
      buildExecutionDiagnosis(ctx.db, ctx.tenant_id, executionId),
      ctx.engineClient.executions.get(executionId),
    ]);
    if (!result.found || !row) {
      return {
        ok: false,
        data: {
          error_code: "execution_not_found",
          message: `no execution ${executionId} on this tenant`,
        },
      };
    }
    const workflow = await describeWorkflow(ctx, result.execution.workflow_id);
    return {
      ok: true,
      data: {
        inspected: {
          execution_id: result.execution.execution_id,
          workflow_id: result.execution.workflow_id,
          workflow_slug: workflow.slug,
          workflow_name: workflow.name,
          selected_by: selectedBy,
        },
        execution: {
          ...result.execution,
          ...describeExecutionEvidence(row),
          trace_id: await executionStartTraceId(ctx.db, ctx.tenant_id, executionId),
        },
        outcome: await ctx.engineClient.executions.outcome(row),
        diagnosis: result.diagnosis,
      },
    };
  },
};
