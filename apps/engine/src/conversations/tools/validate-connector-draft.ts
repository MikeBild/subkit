import { z } from "@hono/zod-openapi";
import { withConnectorDraft } from "../authoring-state.ts";
import { validateConnectorDraft } from "../connector-draft.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z.object({}).openapi("ValidateConnectorDraftToolInput");

export const validateConnectorDraftTool: ConversationTool = {
  name: "validate_connector_draft",
  description:
    "Validate the current connector draft and persist the validation result back into the conversation draft.",
  inputSchema,
  category: "draft_write",
  async execute(ctx): Promise<ToolResult> {
    const draft = ctx.getDraft();
    const connector = draft.connector ?? null;
    const validation = validateConnectorDraft(connector);
    await ctx.setDraft(
      withConnectorDraft(
        draft,
        connector ? { ...connector, validation } : connector,
        "connector_validated",
      ),
    );
    return {
      ok: validation.ok,
      data: {
        connector,
        validation,
      },
    };
  },
};
