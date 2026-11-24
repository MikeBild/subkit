import { z } from "@hono/zod-openapi";
import { isTextLike } from "../../files/content-type.ts";
import { executionDataFileIds } from "../../files/model-context.ts";
import { requireLiveFileForTenant, storageKey } from "../../files/resolver.ts";
import { findConversationAttachmentBySlug } from "../../files/service/index.ts";
import { getObjectStore } from "../../storage/object-store.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const PreviewInput = z
  .object({
    slug: z.string().min(1),
    max_chars: z.number().int().min(100).max(20_000).default(8_000),
  })
  .openapi("PreviewAttachmentToolInput");

export const previewAttachmentTool: ConversationTool = {
  name: "preview_attachment",
  external_output: "file",
  description:
    "Fetch the stored content of an attachment by slug, truncated to max_chars. Use @attachment:<slug> (or a $file ref) in downstream tool inputs for untruncated content.",
  use_case:
    "Peek at an attached file before authoring a workflow against it — understand an OpenAPI spec's shape, a CSV's columns, an operator's notes.",
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
    const link = await findConversationAttachmentBySlug(
      ctx.db,
      ctx.tenant_id,
      ctx.conversation_id,
      args.slug,
    );
    if (
      !link ||
      (await executionDataFileIds(ctx.db, ctx.tenant_id, [link.file_id])).has(link.file_id)
    ) {
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
    let row: Awaited<ReturnType<typeof requireLiveFileForTenant>>;
    try {
      row = await requireLiveFileForTenant(ctx.db, ctx.tenant_id, link.file_id);
    } catch {
      return {
        ok: false,
        data: {
          persistence: "none" as const,
          error: {
            code: "attachment_not_found",
            message: `no file backing slug '${args.slug}'`,
          },
        },
      };
    }
    if (!isTextLike(row.content_type)) {
      return {
        ok: true,
        data: {
          persistence: "none" as const,
          slug: args.slug,
          original_filename: row.filename,
          content_type: row.content_type,
          size_bytes: row.size_bytes,
          note: "binary",
        },
      };
    }
    let raw: string;
    try {
      const it = await getObjectStore().openRead(storageKey(row.storage_uri));
      const chunks: Uint8Array[] = [];
      for await (const c of it) chunks.push(c);
      const total = chunks.reduce((n, c) => n + c.byteLength, 0);
      const buf = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        buf.set(c, off);
        off += c.byteLength;
      }
      raw = new TextDecoder().decode(buf);
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
        slug: args.slug,
        original_filename: row.filename,
        content_type: row.content_type,
        size_bytes: row.size_bytes,
        content,
        _truncated: truncated,
        ...(truncated
          ? { _tip: `Reference @attachment:${args.slug} in downstream tools for full content.` }
          : {}),
      },
    };
  },
};
