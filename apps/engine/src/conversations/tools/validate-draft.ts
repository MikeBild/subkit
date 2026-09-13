// validate_draft — re-run the workflow validator on the current draft.
//
// The loop can call this after a propose_step to get a clean summary
// of the remaining validation errors, or after a round of fixes.

import { z } from "@hono/zod-openapi";

import { validateWorkflowDef } from "../../workflows/validator.ts";
import { getWorkflowDraft, withWorkflowValidation } from "../authoring-state.ts";
import { buildLifecyclePayload } from "./authoring-contract.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z.object({}).openapi("ValidateDraftToolInput");

export const validateDraftTool: ConversationTool = {
  name: "validate_draft",
  description:
    "Re-run the workflow validator on the current draft. Validation state is already inlined into every authoring turn's context (the `- Validation: N errors` section), so this tool is rarely needed — calling it repeatedly with identical args trips the per-tool loop cap. Reserve it for forcing a re-check after a change applied OUTSIDE the conversation.",
  inputSchema,
  category: "draft_write" as const,
  authoring_resource: "workflow",
  async execute(ctx, _args): Promise<ToolResult> {
    const draft = ctx.getDraft();
    const workflowDraft = getWorkflowDraft(draft);
    const validation = validateWorkflowDef(workflowDraft);
    const nextDraft = withWorkflowValidation(
      draft,
      validation.ok,
      validation.ok
        ? `Workflow draft validated with ${workflowDraft.steps.length} step${workflowDraft.steps.length === 1 ? "" : "s"}.`
        : "Workflow draft validation reported blocking issues.",
    );
    await ctx.setDraft(nextDraft);
    if (!validation.ok) {
      return {
        ok: false,
        data: buildLifecyclePayload(nextDraft, {
          name: workflowDraft.name,
          errors: validation.errors,
          steps: workflowDraft.steps.length,
        }),
      };
    }
    return {
      ok: true,
      data: buildLifecyclePayload(nextDraft, {
        name: workflowDraft.name,
        errors: [],
        steps: workflowDraft.steps.length,
      }),
    };
  },
};
