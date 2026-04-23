import { z } from "@hono/zod-openapi";
import { withConnectorValidation } from "../authoring-state.ts";
import { validateConnectorDraft } from "../connector-draft.ts";
import { buildLifecyclePayload } from "./authoring-contract.ts";
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
    const nextDraft = withConnectorValidation(
      draft,
      connector ? { ...connector, validation } : connector,
      validation.ok,
      validation.ok
        ? "Connector draft validated with no blocking issues."
        : "Connector draft validation reported blocking issues.",
    );
    await ctx.setDraft(nextDraft);
    return {
      ok: validation.ok,
      data: buildLifecyclePayload(nextDraft, {
        connector: nextDraft.connector,
        validation,
      }),
    };
  },
};
