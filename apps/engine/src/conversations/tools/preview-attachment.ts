// preview_attachment — read-only fetch of the full stored content of
// a single attachment, up to a cap that keeps the LLM context
// budget sane. For anything beyond the cap the caller should use
// @attachment:<slug> in a downstream tool, which expands to the
// untruncated content right before dispatch.

import { z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { conversationAttachments } from "../../db/schema/index.ts";
import { defaultContentReader } from "../attachments.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const PreviewInput = z
  .object({
    slug: z.string().min(1),
    max_chars: z.number().int().min(100).max(20_000).default(8_000),
  })
  .openapi("PreviewAttachmentToolInput");

export const previewAttachmentTool: ConversationTool = {
  name: "preview_attachment",
  description:
    "Fetch the stored content of an attachment by slug, truncated to max_chars. Use @attachment:<slug> in downstream tool inputs for untruncated content.",
  use_case:
    "Peek at an uploaded file before authoring a workflow against it — understand an OpenAPI spec's shape, a CSV's columns, an operator's notes.",
  important_notes: [
    "Truncates at max_chars (default 8000, hard cap 20000). A `_truncated: true` flag is set when the response is incomplete.",
    "JSON / YAML / text content returns as a plain string. Binary attachments return `{ content_type, size_bytes, note: 'binary' }` without content.",
    "For full content inside a tool input, reference the file via @attachment:<slug> instead of pasting this preview.",
  ],
  example_input: { slug: "stripe-spec", max_chars: 4000 },
  inputSchema: PreviewInput,
  category: "tenant_read",
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = PreviewInput.parse(rawArgs);
    const [row] = await ctx.db
      .select()
      .from(conversationAttachments)
      .where(
        and(
          eq(conversationAttachments.tenant_id, ctx.tenant_id),
          eq(conversationAttachments.conversation_id, ctx.conversation_id),
          eq(conversationAttachments.slug, args.slug),
        ),
      )
      .limit(1);
    if (!row) {
      return {
        ok: false,
        data: {
          persistence: "none" as const,
          error: {
            code: "attachment_not_found",
            message: `no attachment with slug '${args.slug}' on this conversation`,
          },
        },
      };
    }
    const ct = row.content_type ?? "";
    const isBinary = !isTextLike(ct) && !looksLikeText(row.preview ?? "");
    if (isBinary) {
      return {
        ok: true,
        data: {
          persistence: "none" as const,
          slug: row.slug,
          original_filename: row.original_filename,
          content_type: row.content_type,
          size_bytes: row.size_bytes,
          note: "binary",
        },
      };
    }
    let raw: string;
    try {
      raw = await defaultContentReader(row.storage_uri);
    } catch (err) {
      return {
        ok: false,
        data: {
          persistence: "none" as const,
          error: {
            code: "attachment_read_failed",
            message: err instanceof Error ? err.message : String(err),
          },
        },
      };
    }
    const truncated = raw.length > args.max_chars;
    const content = truncated ? raw.slice(0, args.max_chars) : raw;
    return {
      ok: true,
      data: {
        persistence: "none" as const,
        slug: row.slug,
        original_filename: row.original_filename,
        content_type: row.content_type,
        size_bytes: row.size_bytes,
        content,
        _truncated: truncated,
        ...(truncated ? { _tip: `Reference @attachment:${row.slug} in downstream tools for full content.` } : {}),
      },
    };
  },
};

function isTextLike(ct: string): boolean {
  if (!ct) return true; // unknown content-type — prefer text path
  return (
    ct.startsWith("text/") ||
    ct.includes("application/json") ||
    ct.includes("+json") ||
    ct.includes("application/yaml") ||
    ct.includes("+yaml") ||
    ct.includes("application/xml") ||
    ct.includes("+xml") ||
    ct.includes("application/x-www-form-urlencoded")
  );
}

function looksLikeText(preview: string): boolean {
  if (!preview) return false;
  // All chars printable ASCII or common whitespace
  for (let i = 0; i < preview.length; i++) {
    const c = preview.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13) continue;
    if (c < 32 || c > 126) return false;
  }
  return true;
}
