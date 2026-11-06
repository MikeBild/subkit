import { z } from "@hono/zod-openapi";
import { countAuthoringContext, readConversationTargets } from "../service/tool-state.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z.object({}).openapi("InspectAuthoringContextToolInput");

export const inspectAuthoringContextTool: ConversationTool = {
  name: "inspect_authoring_context",
  description:
    "Inspect the authoring context currently in scope for the conversation: draft mode, message/tool counts, attachments, and pending approvals.",
  inputSchema,
  category: "tenant_read",
  authoring_only: true,
  async execute(ctx): Promise<ToolResult> {
    const scope = { tenant_id: ctx.tenant_id, conversation_id: ctx.conversation_id };
    const row = await readConversationTargets(ctx.db, scope);
    const counts = await countAuthoringContext(ctx.db, scope);
    const draft = ctx.getDraft();
    return {
      ok: true,
      data: {
        conversation_id: ctx.conversation_id,
        mode: draft.mode ?? "onboarding",
        target_connector_id: row?.target_connector_id ?? null,
        target_workflow_id: row?.target_workflow_id ?? null,
        summary: draft.summary ?? null,
        counts,
      },
    };
  },
};
