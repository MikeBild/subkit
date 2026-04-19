// update_param — replace a single field on an existing step.

import { z } from "@hono/zod-openapi";
import { validateWorkflowDef } from "../../workflows/validator.ts";
import { getWorkflowDraft, withWorkflowDraft } from "../authoring-state.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z
  .object({
    step_id: z.string().min(1),
    param: z.string().min(1),
    value: z.unknown(),
  })
  .openapi("UpdateParamToolInput");

export const updateParamTool: ConversationTool = {
  name: "update_param",
  description: "Replace a single field on an existing step in the draft.",
  inputSchema,
  category: "draft_write" as const,
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const workflowDraft = structuredClone(getWorkflowDraft(ctx.getDraft()));
    const idx = workflowDraft.steps.findIndex((s) => s.id === args.step_id);
    if (idx < 0) {
      return { ok: false, data: { error: `step not found: ${args.step_id}` } };
    }
    const step = { ...workflowDraft.steps[idx], [args.param]: args.value };
    workflowDraft.steps[idx] = step;
    const validation = validateWorkflowDef(workflowDraft);
    if (!validation.ok) {
      return { ok: false, data: { errors: validation.errors } };
    }
    await ctx.setDraft(withWorkflowDraft(ctx.getDraft(), workflowDraft, "workflow_step_updated"));
    return { ok: true, data: { step_id: args.step_id, param: args.param } };
  },
};
