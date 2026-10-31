import { z } from "@hono/zod-openapi";
import { classifyRequestStepSideEffects } from "../../execution/steps/request/side-effects.ts";
import type { RequestStep } from "../../workflows/types.ts";
import { pendingInactiveDraft, persistedResourceForKind } from "../authoring-state/summary.ts";
import { getWorkflowDraft, withWorkflowInspection } from "../authoring-state.ts";
import type { WorkflowDraftStepPreview } from "../types.ts";
import { buildLifecyclePayload } from "./authoring-contract.ts";
import type { ConversationTool, ToolResult } from "./index.ts";
import { savedDraftReadiness } from "./saved-draft-readiness.ts";

const inputSchema = z
  .object({
    step_ids: z.array(z.string().min(1)).min(1).max(64).optional(),
    include_preview: z.boolean().optional().default(false),
  })
  .openapi("InspectWorkflowDraftToolInput");

export const inspectWorkflowDraftTool: ConversationTool = {
  name: "inspect_workflow_draft",
  description:
    "Inspect current draft step IDs, request settings and next action without large execution payloads. Use step_ids to retrieve full configuration of specific steps; use those IDs with edit_workflow_patch.step_patches instead of guessing indices. Set include_preview only when output shapes are needed. Configuration-only repairs do not need get_raw_result.",
  inputSchema,
  category: "draft_write",
  authoring_resource: "workflow",
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const nextDraft = withWorkflowInspection(ctx.getDraft());
    await ctx.setDraft(nextDraft);
    const workflow = getWorkflowDraft(nextDraft);

    const traceById = new Map<string, WorkflowDraftStepPreview>();
    const traces = args.include_preview ? nextDraft.latest_preview?.step_traces : undefined;
    if (Array.isArray(traces)) {
      for (const t of traces) traceById.set(t.step_id, t);
    }

    const boundWorkflow = nextDraft.state
      ? persistedResourceForKind(nextDraft.state, "workflow")
      : null;
    const readiness =
      boundWorkflow && nextDraft.state && pendingInactiveDraft(nextDraft.state)
        ? await savedDraftReadiness(ctx, boundWorkflow.id)
        : null;
    const reviewBlocked = (readiness?.issues?.length ?? 0) > 0;

    const payload = buildLifecyclePayload(
      nextDraft,
      {
        name: workflow.name,
        steps: workflow.steps.length,
        last_step_id: workflow.steps[workflow.steps.length - 1]?.id ?? null,
        step_type:
          typeof workflow.steps[workflow.steps.length - 1]?.kind === "string"
            ? (workflow.steps[workflow.steps.length - 1]?.kind as string)
            : null,
        workflow: {
          name: workflow.name,
          slug: workflow.slug ?? null,
          description: workflow.description ?? null,
          input_schema: workflow.input_schema ?? null,
          step_count: workflow.steps.length,
          steps: workflow.steps.flatMap((step, index) => {
            const id = typeof step.id === "string" ? step.id : `step-${index + 1}`;
            if (args.step_ids && !args.step_ids.includes(id)) return [];
            const trace = traceById.get(id);
            const sideEffect =
              step.kind === "request"
                ? classifyRequestStepSideEffects(step as unknown as RequestStep)
                : step.kind === "call"
                  ? "write"
                  : "read";
            return {
              index,
              id,
              kind: typeof step.kind === "string" ? step.kind : "unknown",
              side_effect: sideEffect,
              fields: Object.keys(step).sort(),
              ...(args.step_ids ? { configuration: step } : {}),
              ...(step.kind === "request"
                ? {
                    method: step.method,
                    connector_id: step.connector_id,
                    s3: step.s3,
                    url: step.url,
                  }
                : {}),
              ...(trace
                ? {
                    latest_preview: {
                      status: trace.status,
                      ...(trace.duration_ms != null ? { duration_ms: trace.duration_ms } : {}),
                      ...(trace.output_preview !== undefined
                        ? { output_preview: trace.output_preview }
                        : {}),
                      ...(trace.raw_preview !== undefined
                        ? { raw_preview: trace.raw_preview }
                        : {}),
                      ...(trace.scope_at_step ? { scope_at_step: trace.scope_at_step } : {}),
                      ...(trace.error_code ? { error_code: trace.error_code } : {}),
                    },
                  }
                : {
                    latest_preview: {
                      status: args.include_preview ? "no_result" : "not_requested",
                    },
                  }),
            };
          }),
          edges: workflow.edges ?? [],
        },
        latest_preview: nextDraft.latest_preview
          ? {
              ok: nextDraft.latest_preview.ok,
              summary: nextDraft.latest_preview.summary,
              requires_repair: nextDraft.latest_preview.requires_repair,
              warnings: nextDraft.latest_preview.warnings,
            }
          : null,
      },
      { readOnly: true },
    );
    if (!readiness) return { ok: true, data: payload };
    return {
      ok: true,
      data: {
        ...payload,
        ...(reviewBlocked ? withReviewBlocker(payload) : {}),
        saved_draft_readiness: readiness,
      },
    };
  },
};

function withReviewBlocker(payload: Record<string, unknown>): Record<string, unknown> {
  const reasons = Array.isArray(payload.blocking_reasons) ? payload.blocking_reasons : [];
  const summary =
    payload.summary && typeof payload.summary === "object"
      ? (payload.summary as Record<string, unknown>)
      : null;
  const blockedBy = Array.isArray(summary?.blocked_by) ? summary.blocked_by : [];
  return {
    blocking_reasons: [...new Set([...reasons, "automation_review_issues"])],
    ...(summary
      ? {
          summary: {
            ...summary,
            blocked_by: [...new Set([...blockedBy, "automation_review_issues"])],
          },
        }
      : {}),
  };
}
