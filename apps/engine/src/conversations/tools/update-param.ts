// update_param — replace a single field on an existing step.

import { z } from "@hono/zod-openapi";
import { validateWorkflowDef } from "../../workflows/validator.ts";
import type { DraftDocument } from "../types.ts";
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
    const draft = structuredClone(ctx.getDraft()) as DraftDocument;
    const idx = draft.steps.findIndex((s) => s.id === args.step_id);
    if (idx < 0) {
      return { ok: false, data: { error: `step not found: ${args.step_id}` } };
    }
    const step = { ...draft.steps[idx], [args.param]: args.value };
    draft.steps[idx] = step;
    const validation = validateWorkflowDef(draft);
    if (!validation.ok) {
      return { ok: false, data: { errors: validation.errors } };
    }
    await ctx.setDraft(draft);
    return { ok: true, data: { step_id: args.step_id, param: args.param } };
  },
};
