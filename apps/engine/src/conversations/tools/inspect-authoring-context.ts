import { z } from "@hono/zod-openapi";
import { and, eq, sql } from "drizzle-orm";
import {
  conversationElicitations,
  conversationMessages,
  conversations,
  conversationToolCalls,
  fileLinks,
} from "../../db/schema/index.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z.object({}).openapi("InspectAuthoringContextToolInput");

export const inspectAuthoringContextTool: ConversationTool = {
  name: "inspect_authoring_context",
  description:
    "Inspect the authoring context currently in scope for the conversation: draft mode, message/tool counts, attachments, and pending approvals.",
  inputSchema,
  category: "tenant_read",
  async execute(ctx): Promise<ToolResult> {
    const [row] = await ctx.db
      .select({
        target_connector_id: conversations.target_connector_id,
        target_workflow_id: conversations.target_workflow_id,
      })
      .from(conversations)
      .where(
        and(eq(conversations.tenant_id, ctx.tenant_id), eq(conversations.id, ctx.conversation_id)),
      )
      .limit(1);
    const [messageCount, toolCallCount, attachmentCount, pendingCount] = await Promise.all([
      ctx.db
        .select({ count: sql<number>`count(*)::int` })
        .from(conversationMessages)
        .where(
          and(
            eq(conversationMessages.tenant_id, ctx.tenant_id),
            eq(conversationMessages.conversation_id, ctx.conversation_id),
          ),
        ),
      ctx.db
        .select({ count: sql<number>`count(*)::int` })
        .from(conversationToolCalls)
        .where(
          and(
            eq(conversationToolCalls.tenant_id, ctx.tenant_id),
            eq(conversationToolCalls.conversation_id, ctx.conversation_id),
          ),
        ),
      ctx.db
        .select({ count: sql<number>`count(*)::int` })
        .from(fileLinks)
        .where(
          and(
            eq(fileLinks.tenant_id, ctx.tenant_id),
            eq(fileLinks.resource_type, "conversation"),
            eq(fileLinks.resource_id, ctx.conversation_id),
          ),
        ),
      ctx.db
        .select({ count: sql<number>`count(*)::int` })
        .from(conversationElicitations)
        .where(
          and(
            eq(conversationElicitations.tenant_id, ctx.tenant_id),
            eq(conversationElicitations.conversation_id, ctx.conversation_id),
            eq(conversationElicitations.status, "pending"),
          ),
        ),
    ]);
    const draft = ctx.getDraft();
    return {
      ok: true,
      data: {
        conversation_id: ctx.conversation_id,
        mode: draft.mode ?? "onboarding",
        target_connector_id: row?.target_connector_id ?? null,
        target_workflow_id: row?.target_workflow_id ?? null,
        summary: draft.summary ?? null,
        counts: {
          messages: messageCount[0]?.count ?? 0,
          tool_calls: toolCallCount[0]?.count ?? 0,
          attachments: attachmentCount[0]?.count ?? 0,
          pending_elicitations: pendingCount[0]?.count ?? 0,
        },
      },
    };
  },
};
