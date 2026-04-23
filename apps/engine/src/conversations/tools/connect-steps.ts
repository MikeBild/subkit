// connect_steps — declare an ordering relationship between two steps.
//
// Execution order is implicit in the step array, so the current
// implementation records the edge on the draft metadata. Step
// reordering is future work; the tool still passes validation back
// so the loop can react to missing step ids.

import { z } from "@hono/zod-openapi";
import { getWorkflowDraft, withWorkflowDraft } from "../authoring-state.ts";
import { buildDraftMutationPayload, buildGateError } from "./authoring-contract.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
  })
  .openapi("ConnectStepsToolInput");

export const connectStepsTool: ConversationTool = {
  name: "connect_steps",
  description: "Declare an ordering edge between two steps in the draft.",
  inputSchema,
  category: "draft_write" as const,
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const currentDraft = ctx.getDraft();
    const workflowDraft = structuredClone(getWorkflowDraft(currentDraft));
    const fromIdx = workflowDraft.steps.findIndex((s) => s.id === args.from);
    const toIdx = workflowDraft.steps.findIndex((s) => s.id === args.to);
    if (fromIdx < 0) {
      return {
        ok: false,
        data: buildGateError(currentDraft, {
          error_code: "unknown_step",
          message: `unknown step id: ${args.from}`,
          recommended_mode: "workflow",
          next_best_actions: ["inspect_workflow_draft"],
        }),
      };
    }
    if (toIdx < 0) {
      return {
        ok: false,
        data: buildGateError(currentDraft, {
          error_code: "unknown_step",
          message: `unknown step id: ${args.to}`,
          recommended_mode: "workflow",
          next_best_actions: ["inspect_workflow_draft"],
        }),
      };
    }
    const edges = workflowDraft.edges ?? [];
    edges.push({ from: args.from, to: args.to });
    workflowDraft.edges = edges;
    // Reorder so `to` follows `from` when it doesn't already — this
    // is a gentle hint so the engine runs them in the requested order.
    if (toIdx < fromIdx) {
      const [moved] = workflowDraft.steps.splice(toIdx, 1);
      if (moved) workflowDraft.steps.splice(fromIdx, 0, moved);
    }
    const nextDraft = withWorkflowDraft(currentDraft, workflowDraft, "workflow_steps_connected");
    await ctx.setDraft(nextDraft);
    return {
      ok: true,
      data: buildDraftMutationPayload(nextDraft, {
        resource_kind: "workflow",
        extra: {
          from: args.from,
          to: args.to,
          edges: edges.length,
          steps: workflowDraft.steps.length,
          last_step_id: workflowDraft.steps[workflowDraft.steps.length - 1]?.id ?? null,
        },
      }),
    };
  },
};
