// list_attachments — read-only listing of files attached to this
// conversation. Routes through the unified `files` + `file_links`
// resource: `file_links WHERE resource_type='conversation' AND
// resource_id=<conv>` joined with `files`. The output schema mirrors
// the legacy per-conversation table shape so the LLM and the MCP tool
// surface keep the same projection.

import { z } from "@hono/zod-openapi";
import { and, desc, eq } from "drizzle-orm";

import { fileLinks, files } from "../../db/schema/index.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const ListInput = z.object({}).openapi("ListAttachmentsToolInput");

export const listAttachmentsTool: ConversationTool = {
  name: "list_attachments",
  description: "List every file the operator has attached to this conversation.",
  use_case:
    "Call at the start of an authoring flow to see what specs / samples the operator has attached. Each row's slug is the token you reference via @attachment:<slug> from any tool input; the engine rewrites the slug to a canonical $file ref at message ingest.",
  important_notes: [
    "Per-conversation scope only; other conversations' attachments are invisible.",
    "Files joined via file_links — the same file id may be linked to multiple resources.",
    "Ordered newest-first.",
  ],
  inputSchema: ListInput,
  category: "tenant_read",
  async execute(ctx): Promise<ToolResult> {
    const rows = await ctx.db
      .select({ link: fileLinks, file: files })
      .from(fileLinks)
      .innerJoin(files, eq(files.id, fileLinks.file_id))
      .where(
        and(
          eq(fileLinks.tenant_id, ctx.tenant_id),
          eq(fileLinks.resource_type, "conversation"),
          eq(fileLinks.resource_id, ctx.conversation_id),
        ),
      )
      .orderBy(desc(fileLinks.created_at))
      .limit(50);
    return {
      ok: true,
      data: {
        persistence: "none" as const,
        attachments: rows.map((r) => ({
          slug: r.link.slug,
          original_filename: r.file.filename,
          content_type: r.file.content_type,
          size_bytes: r.file.size_bytes,
          sha256: r.file.sha256,
          created_at: r.link.created_at.toISOString(),
        })),
      },
    };
  },
};
