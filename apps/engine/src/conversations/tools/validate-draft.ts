// validate_draft — re-run the workflow validator on the current draft.
//
// The loop can call this after a propose_step to get a clean summary
// of the remaining validation errors, or after a round of fixes.

import { z } from "@hono/zod-openapi";
import { validateWorkflowDef } from "../../workflows/validator.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z.object({}).openapi("ValidateDraftToolInput");

export const validateDraftTool: ConversationTool = {
  name: "validate_draft",
  description: "Validate the current draft and return the list of errors.",
  inputSchema,
  async execute(ctx, _args): Promise<ToolResult> {
    const draft = ctx.getDraft();
    const validation = validateWorkflowDef(draft);
    if (!validation.ok) {
      return { ok: false, data: { errors: validation.errors } };
    }
    return { ok: true, data: { errors: [], steps: draft.steps.length } };
  },
};
