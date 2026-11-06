import { z } from "@hono/zod-openapi";
import { getWorkflowDraft, withAuthoringFocus } from "../authoring-state/index.ts";
import { CONNECTOR_AUTHORING_SKILL, WORKFLOW_AUTHORING_SKILL } from "./authoring-palette.ts";
import type { ConversationTool, ToolResult } from "./index.ts";
import { loadSkillTool } from "./load-skill.ts";

const inputSchema = z
  .object({
    focus: z
      .enum(["connector", "workflow"])
      .describe(
        "connector: author a new connector now; the workflow draft stays untouched. workflow: return to the workflow draft, or start one.",
      ),
    discard_unsaved_connector: z
      .boolean()
      .default(false)
      .describe(
        "Only for focus=workflow while an unsaved connector draft exists: drop that connector draft. Pass true only after the user agreed to discard it.",
      ),
  })
  .openapi("SwitchAuthoringFocusToolInput");

export const switchAuthoringFocusTool: ConversationTool = {
  name: "switch_authoring_focus",
  description:
    "Switch this conversation between connector and workflow authoring without losing work. focus=connector keeps the workflow draft and opens connector authoring; after save_connector_draft call it again with focus=workflow to continue the workflow. focus=workflow leaves connector authoring; an unsaved connector draft must be saved first or explicitly discarded.",
  use_case:
    "A workflow draft needs a connector that does not exist yet, or a connector draft was started by mistake and the user wants a workflow instead.",
  important_notes: [
    "Never discards the workflow draft. A saved connector stays saved; only an unsaved connector draft can be discarded, and only with discard_unsaved_connector=true.",
    "Loads the matching authoring skill so the connector or workflow tools are offered in the next step.",
  ],
  inputSchema,
  category: "draft_write" as const,
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const draft = ctx.getDraft();
    const connector = draft.connector ?? null;
    const unsavedConnector = connector !== null && typeof connector.saved_connector_id !== "string";
    const workflowSteps = getWorkflowDraft(draft).steps.length;

    if (args.focus === "workflow" && unsavedConnector && !args.discard_unsaved_connector) {
      return {
        ok: false,
        data: {
          error: {
            code: "connector_draft_unsaved",
            message:
              "An unsaved connector draft is open. Save it with save_connector_draft, or ask the user whether to discard it and call again with discard_unsaved_connector=true.",
          },
          connector: { name: connector?.name ?? null, slug: connector?.slug ?? null },
        },
      };
    }

    const dropConnector =
      args.focus === "workflow"
        ? unsavedConnector
        : connector !== null && typeof connector.saved_connector_id === "string";
    await ctx.setDraft(withAuthoringFocus(draft, args.focus, { dropConnector }));
    await loadSkillTool.execute(ctx, {
      slug: args.focus === "connector" ? CONNECTOR_AUTHORING_SKILL : WORKFLOW_AUTHORING_SKILL,
    });

    return {
      ok: true,
      data: {
        focus: args.focus,
        workflow_draft_steps: workflowSteps,
        connector_draft_discarded: args.focus === "workflow" && unsavedConnector,
        next:
          args.focus === "connector"
            ? "Start the connector with start_connector_from_template or start_connector_from_description, then validate, probe and save it. Afterwards call switch_authoring_focus with focus=workflow."
            : workflowSteps > 0
              ? "Continue the workflow draft: inspect_workflow_draft, then validate and preview before saving."
              : "Start the workflow with author_workflow, open_workflow_draft or start_workflow_from_recipe.",
      },
    };
  },
};
