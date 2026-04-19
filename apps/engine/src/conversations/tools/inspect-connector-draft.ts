import { z } from "@hono/zod-openapi";
import { validateConnectorDraft } from "../connector-draft.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z.object({}).openapi("InspectConnectorDraftToolInput");

export const inspectConnectorDraftTool: ConversationTool = {
  name: "inspect_connector_draft",
  description:
    "Inspect the current connector draft, including missing fields, validation state, latest probe, and the recommended next action.",
  inputSchema,
  category: "draft_write",
  async execute(ctx): Promise<ToolResult> {
    const draft = ctx.getDraft();
    const validation = validateConnectorDraft(draft.connector ?? null);
    return {
      ok: true,
      data: {
        mode: draft.mode ?? "onboarding",
        connector: draft.connector,
        validation,
        summary: draft.summary ?? null,
      },
    };
  },
};
