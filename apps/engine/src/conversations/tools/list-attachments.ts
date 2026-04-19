// list_attachments — read-only listing of files uploaded to this
// conversation. Used by the LLM to discover what the operator has
// attached so it can reference them via @attachment:<slug>.

import { z } from "@hono/zod-openapi";
import { and, desc, eq } from "drizzle-orm";
import { conversationAttachments } from "../../db/schema/index.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const ListInput = z.object({}).openapi("ListAttachmentsToolInput");

export const listAttachmentsTool: ConversationTool = {
  name: "list_attachments",
  description: "List every file the operator has uploaded to this conversation.",
  use_case:
    "Call at the start of an authoring flow to see what specs / samples the operator has attached. Each row's slug is the token you reference via @attachment:<slug> from any tool input.",
  important_notes: [
    "Per-conversation scope only; other conversations' attachments are invisible.",
    "Preview is the first ~2000 chars of text/JSON/YAML — use preview_attachment for the full content.",
    "Ordered newest-first.",
  ],
  inputSchema: ListInput,
  category: "tenant_read",
  async execute(ctx): Promise<ToolResult> {
    const rows = await ctx.db
      .select({
        slug: conversationAttachments.slug,
        original_filename: conversationAttachments.original_filename,
        content_type: conversationAttachments.content_type,
        size_bytes: conversationAttachments.size_bytes,
        sha256: conversationAttachments.sha256,
        preview: conversationAttachments.preview,
        created_at: conversationAttachments.created_at,
      })
      .from(conversationAttachments)
      .where(
        and(
          eq(conversationAttachments.tenant_id, ctx.tenant_id),
          eq(conversationAttachments.conversation_id, ctx.conversation_id),
        ),
      )
      .orderBy(desc(conversationAttachments.created_at))
      .limit(50);
    return {
      ok: true,
      data: {
        persistence: "none" as const,
        attachments: rows.map((r) => ({
          slug: r.slug,
          original_filename: r.original_filename,
          content_type: r.content_type,
          size_bytes: r.size_bytes,
          sha256: r.sha256,
          preview: r.preview,
          created_at: r.created_at.toISOString(),
        })),
      },
    };
  },
};
