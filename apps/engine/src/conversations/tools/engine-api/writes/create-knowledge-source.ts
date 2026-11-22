import { z } from "@hono/zod-openapi";
import { executionDataFileIds } from "../../../../files/model-context.ts";
import type { FileRow } from "../../../../files/resolver.ts";
import { requireFileForTenant, resolvedFromRow } from "../../../../files/resolver.ts";
import { KnowledgeBudgetExceededError } from "../../../../knowledge/budgets.ts";
import { log } from "../../../../logging/index.ts";
import type { ConversationTool, ToolResult } from "../../index.ts";
import { buildKnowledgeSourceUsage } from "../../usage-guidance.ts";

const CreateKnowledgeSourceOutputData = z.object({
  created: z.literal(true),
  knowledge_source: z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    description: z.string().nullable(),
    tags: z.array(z.string()),
    scope: z.string(),
    status: z.string(),
    chunk_count: z.number(),
    bytes_total: z.number(),
    mime_type: z.string().optional(),
    filename: z.string().optional(),
  }),
  audit_log_id: z.string(),
});
export type CreateKnowledgeSourceOutputData = z.infer<typeof CreateKnowledgeSourceOutputData>;

const CreateKnowledgeSourceInput = z
  .object({
    mode: z.enum(["inline", "from_attachment"]),
    name: z.string().min(1).max(200).optional(),
    content: z.string().min(1).optional(),
    mime_type: z.string().optional(),
    source_uri: z.string().url().optional(),
    file_id: z.string().regex(/^fid_/, "file_id must start with 'fid_'").optional(),
    description: z.string().max(2000).optional(),
    tags: z.array(z.string().min(1).max(40)).max(20).optional(),
    scope: z.enum(["global", "workflow"]).optional(),
    workflow_id: z.string().uuid().optional(),
  })
  .refine(
    (v) => {
      if (v.mode === "inline") return Boolean(v.name && v.content);
      if (v.mode === "from_attachment") return Boolean(v.file_id);
      return false;
    },
    {
      message:
        "mode='inline' requires 'name' and 'content'; mode='from_attachment' requires 'file_id'",
    },
  )
  .openapi("CreateKnowledgeSourceToolInput");

async function readAllBytes(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function defaultNameFromFilename(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, "");
  return base.length > 0 ? base : filename;
}

const GENERIC_NAME_PATTERNS = [
  /^uploaded\s+knowledge\s+source$/i,
  /^uploaded\s+file$/i,
  /^uploaded\s+document$/i,
  /^uploaded\s+content$/i,
  /^new\s+knowledge\s+source$/i,
  /^new\s+file$/i,
  /^new\s+document$/i,
  /^pasted\s+(content|text|document|file)$/i,
  /^attachment$/i,
  /^file$/i,
  /^document$/i,
  /^content$/i,
  /^untitled$/i,
  /^untitled[-_\s]\d+$/i,
  /^knowledge\s+source$/i,
];

function isGenericName(name: string): boolean {
  return GENERIC_NAME_PATTERNS.some((re) => re.test(name.trim()));
}

export { isGenericName };

export const createKnowledgeSourceTool: ConversationTool = {
  name: "create_knowledge_source",
  description:
    "Ingest content as a tenant Knowledge Source. Accepts inline markdown/text/JSON (mode='inline' with name + content) or an existing conversation attachment (mode='from_attachment' with file_id). Supported file types: markdown, plaintext, JSON, YAML, XML, CSV, PDF, DOCX, XLSX, PPTX. For knowledge-source intents, subkit uploads local files before the agent message is sent, so the prompt usually already contains a `{\"$file\":\"fid_…\"}` leaf — call mode='from_attachment' with that file_id. Use mode='inline' only for text the user pasted directly into chat. For mode='from_attachment', OMIT `name` unless the user explicitly named the source — the engine derives a clean name from the uploaded filename (e.g. `OCPP-2.0.1.md` → `OCPP-2.0.1`). NEVER invent generic placeholders like 'Uploaded Knowledge Source' or 'Attachment'.",
  use_case:
    'Use when the user asks to add a file, document, or pasted content as searchable knowledge. If the prompt contains a `{"$file":"fid_…"}` leaf, use mode=\'from_attachment\' with that file_id AND OMIT `name` so the engine uses the real filename. Only set `name` when the user explicitly typed one in the chat (e.g. "name it Internal API Docs"). For pasted text or LLM-generated content, use mode=\'inline\'. If the user mentions a path string but no fid_… is present, the file was not available to subkit — ask the user to check the path rather than calling this tool with the raw path string as `content`.',
  important_notes: [
    "Re-runs with identical content are idempotent at the chunk level — the engine deduplicates.",
    "scope='workflow' requires workflow_id; omit both to default to global scope.",
    "mode='from_attachment' with no `name` argument is the common case — the engine derives the name from the file's filename. Passing a generic placeholder defeats the default and leaks into the slug and KS listings.",
    "Tenant has a global byte budget; very large files may be rejected with `budget_exceeded`.",
    "Omit `description`/`tags` to let the engine auto-generate them from the content; pass them only when the user dictates specific values.",
  ],
  example_input: {
    mode: "inline",
    name: "Refund policy",
    content: "# Refund policy\n\nRefunds above 500 EUR need a second approver.",
  },
  inputSchema: CreateKnowledgeSourceInput,
  category: "tenant_write",
  permission: { action: "knowledge:write", resourceType: "knowledge" },
  async execute(ctx, args: z.infer<typeof CreateKnowledgeSourceInput>): Promise<ToolResult> {
    let buffer: Buffer;
    let filename: string;
    let mime: string | undefined;
    let name: string;
    let source_type_override: "file_upload" | "inline";
    let source_uri_override: string;

    if (args.mode === "from_attachment") {
      const file_id = args.file_id as string;
      let row: FileRow;
      try {
        row = await requireFileForTenant(ctx.db, ctx.tenant_id, file_id);
      } catch (err) {
        return {
          ok: false,
          data: {
            error: "file_not_found",
            reason: err instanceof Error ? err.message : String(err),
            file_id,
          },
        };
      }
      if ((await executionDataFileIds(ctx.db, ctx.tenant_id, [row.id])).has(row.id))
        return {
          ok: false,
          data: {
            error: "execution_data_only",
            reason:
              "This file is reserved for direct workflow transfer and cannot enter knowledge or model context.",
          },
        };
      const resolved = resolvedFromRow(row);
      const stream = await resolved.openRead();
      buffer = await readAllBytes(stream);
      filename = resolved.filename;
      mime = resolved.content_type ?? undefined;
      name = args.name && !isGenericName(args.name) ? args.name : defaultNameFromFilename(filename);
      source_type_override = "file_upload";
      source_uri_override = filename;
    } else {
      const inlineName = args.name as string;
      const inlineContent = args.content as string;
      buffer = Buffer.from(inlineContent, "utf8");
      mime = args.mime_type ?? "text/markdown";
      name = inlineName;
      filename = args.source_uri ?? `${name}.md`;
      source_type_override = "inline";
      source_uri_override = args.source_uri ?? filename;
    }

    try {
      let view = await ctx.engineClient.knowledgeSources.create({
        input: {
          name,
          ...(args.description !== undefined ? { description: args.description } : {}),
          ...(args.tags !== undefined ? { tags: args.tags } : {}),
          ...(args.scope !== undefined ? { scope: args.scope } : {}),
          ...(args.workflow_id !== undefined ? { workflow_id: args.workflow_id } : {}),
        },
        upload: { buffer, filename, ...(mime ? { mime } : {}) },
        source_type_override,
        source_uri_override,
      });

      if (view.description === null || view.tags.length === 0) {
        try {
          const enriched = await ctx.engineClient.knowledgeSources.analyze(view.id, {});
          if (enriched) view = enriched;
        } catch (enrichErr) {
          log.knowledge.analyze_skipped({
            knowledge_source_id: view.id,
            tenant_id: ctx.tenant_id,
            error: enrichErr instanceof Error ? enrichErr.message : String(enrichErr),
          });
        }
      }

      const audit_log_id = await ctx.engineClient.audit_write({
        resource_type: "knowledge_source",
        resource_id: view.id,
        action: "conversation.create_knowledge_source",
        result: "success",
        metadata: {
          conversation_id: ctx.conversation_id,
          mode: args.mode,
          scope: view.scope,
          chunk_count: view.chunk_count,
          bytes_total: view.bytes_total,
          ...(args.mode === "from_attachment" ? { file_id: args.file_id } : {}),
        },
      });

      const usage = buildKnowledgeSourceUsage({
        id: view.id,
        slug: view.slug,
        name: view.name,
        description: view.description,
        scope: view.scope,
        chunk_count: view.chunk_count,
        workflow_id: args.workflow_id ?? null,
      });
      return {
        ok: true,
        data: {
          created: true,
          knowledge_source: {
            id: view.id,
            name: view.name,
            slug: view.slug,
            description: view.description,
            tags: view.tags,
            scope: view.scope,
            status: view.status,
            chunk_count: view.chunk_count,
            bytes_total: view.bytes_total,
            ...(mime ? { mime_type: mime } : {}),
            ...(filename ? { filename } : {}),
          },
          audit_log_id,
          usage,
          next_best_actions: ["search_knowledge", "list_knowledge_sources"],
          next_prompt: usage.follow_up,
        },
      };
    } catch (err) {
      if (err instanceof KnowledgeBudgetExceededError) {
        return { ok: false, data: { error: "budget_exceeded", message: err.message } };
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("workflow_id is required when scope is 'workflow'")) {
        return {
          ok: false,
          data: { error: "scope_workflow_requires_workflow_id", message: msg },
        };
      }
      return { ok: false, data: { error: "create_failed", message: msg } };
    }
  },
};
