import { z } from "@hono/zod-openapi";
import { getWorkflowDraft } from "../authoring-state.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z.object({}).openapi("InspectWorkflowDraftToolInput");

export const inspectWorkflowDraftTool: ConversationTool = {
  name: "inspect_workflow_draft",
  description:
    "Inspect the current workflow draft, including step order, validation summary, latest preview, and the recommended next action.",
  inputSchema,
  category: "draft_write",
  async execute(ctx): Promise<ToolResult> {
    const draft = ctx.getDraft();
    const workflow = getWorkflowDraft(draft);
    return {
      ok: true,
      data: {
        mode: draft.mode ?? "onboarding",
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
        latest_preview: draft.latest_preview ?? null,
        summary: draft.summary ?? null,
      },
    };
  },
};
