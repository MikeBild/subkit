// propose_step — append a step to the draft and validate.
//
// The tool always returns so the loop can feed any validation errors
// back to the model on the next iteration. On success the draft is
// snapshotted to `conversation_drafts`.

import { z } from "@hono/zod-openapi";
import { validateWorkflowDef } from "../../workflows/validator.ts";
import type { DraftDocument } from "../types.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z
  .object({
    step: z.record(z.string(), z.unknown()),
  })
  .openapi("ProposeStepToolInput");

export const proposeStepTool: ConversationTool = {
  name: "propose_step",
  description:
    "Add a step to the draft workflow. Returns validation errors when the step is malformed.",
  inputSchema,
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const draft = structuredClone(ctx.getDraft()) as DraftDocument;
    // Replace a step with the same id if present, otherwise append.
    const stepId = typeof args.step.id === "string" ? (args.step.id as string) : undefined;
    if (stepId) {
      const existing = draft.steps.findIndex((s) => s.id === stepId);
      if (existing >= 0) {
        draft.steps[existing] = args.step;
      } else {
        draft.steps.push(args.step);
      }
    } else {
      draft.steps.push(args.step);
    }
    // Tentatively validate — if it fails we do NOT snapshot, and we
    // return the errors so the loop can feed them back to the model.
    const validation = validateWorkflowDef(draft);
    if (!validation.ok) {
      return {
        ok: false,
        data: {
          errors: validation.errors,
          message: "step invalid — see errors and retry with update_param or another propose_step",
        },
      };
    }
    await ctx.setDraft(draft);
    return {
      ok: true,
      data: {
        steps: draft.steps.length,
        last_step_id: draft.steps[draft.steps.length - 1]?.id ?? null,
      },
    };
  },
};
