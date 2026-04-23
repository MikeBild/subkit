import { z } from "@hono/zod-openapi";
import { getWorkflowDraft, withWorkflowInspection } from "../authoring-state.ts";
import { buildLifecyclePayload } from "./authoring-contract.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z.object({}).openapi("InspectWorkflowDraftToolInput");

export const inspectWorkflowDraftTool: ConversationTool = {
  name: "inspect_workflow_draft",
  description:
    "Inspect the current workflow draft, including step order, validation summary, latest preview, and the recommended next action.",
  inputSchema,
  category: "draft_write",
  async execute(ctx): Promise<ToolResult> {
    const nextDraft = withWorkflowInspection(ctx.getDraft());
    await ctx.setDraft(nextDraft);
    const workflow = getWorkflowDraft(nextDraft);
    return {
      ok: true,
      data: buildLifecyclePayload(nextDraft, {
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
          step_count: workflow.steps.length,
          steps: workflow.steps.map((step, index) => ({
            index,
            id: typeof step.id === "string" ? step.id : `step-${index + 1}`,
            kind: typeof step.kind === "string" ? step.kind : "unknown",
            fields: Object.keys(step).sort(),
          })),
          edges: workflow.edges ?? [],
        },
        latest_preview: nextDraft.latest_preview ?? null,
      }),
    };
  },
};
