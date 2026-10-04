// create_knowledge_source — ingest content as a tenant Knowledge Source
// from inline text or an existing conversation attachment (fid_…).
//
// Closes the gap surfaced in session a6450b39 where `sk chat` said
// "please upload the file first" then had no tool to convert the
// attachment into a Knowledge Source. The chat agent + every external
// MCP client now has a write tool that reuses the same
// `svc.createKnowledgeSource` ingestion path the HTTP route and CLI
// already share — chunking, dedup, budget, audit all inherited.
//
// Schema shape note: Anthropic's tool API requires `input_schema.type ===
// "object"` with no `anyOf`/`oneOf` at the root, so the two modes are
// expressed as a flat object + `.refine()` rather than a discriminated
// union. Mode-specific field requirements are enforced both at the Zod
// boundary and in `execute()`.

import { z } from "@hono/zod-openapi";
import type { FileRow } from "../../../../files/resolver.ts";
import { requireFileForTenant, resolvedFromRow } from "../../../../files/resolver.ts";
import { KnowledgeBudgetExceededError } from "../../../../knowledge/budgets.ts";
import { log } from "../../../../logging/logger.ts";
import type { ConversationTool, ToolResult } from "../../index.ts";
import { buildKnowledgeSourceUsage } from "../../usage-guidance.ts";

// Output shape on success — exported so downstream consumers (sk REPL
// authoring-cards extractor) can build structural-overlap fixtures and
// catch shape drift at compile time. The Zod definition is the single
// source of truth; behaviour is unchanged.
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
    // Mirror back the resolved MIME and filename so client renderers
    // (e.g. the Ink authoring card at `apps/sk/src/repl/authoring-
    // cards.tsx:extractKnowledgeSourceSummary`) can show the real
    // content_type / filename without re-fetching the file row.
    // Pre-6.2.12 the sk card hardcoded `application/octet-stream` for
    // `mode='from_attachment'` because the response didn't carry the
    // MIME — surfaced in the OCPP-2.0.1.md session repro.
    mime_type: z.string().optional(),
    filename: z.string().optional(),
  }),
  audit_log_id: z.string(),
});
export type CreateKnowledgeSourceOutputData = z.infer<typeof CreateKnowledgeSourceOutputData>;
export type CreateKnowledgeSourceOutput = {
  ok: true;
  data: CreateKnowledgeSourceOutputData;
};

const CreateKnowledgeSourceInput = z
  .object({
    mode: z.enum(["inline", "from_attachment"]),
    // mode='inline' fields
    name: z.string().min(1).max(200).optional(),
    content: z.string().min(1).optional(),
    mime_type: z.string().optional(),
    source_uri: z.string().url().optional(),
    // mode='from_attachment' field
    file_id: z.string().regex(/^fid_/, "file_id must start with 'fid_'").optional(),
    // shared
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

// Catch generic placeholders the LLM sometimes invents when it can't
// see the filename (e.g. when sk's preprocessor rewrote a path token
// to `{"$file":"fid_..."}` and the agent had no human-readable hint).
// These leak into the KS title, slug, audit metadata and `/knowledge`
// list — surfaced in the OCPP-2.0.1.md session as "Uploaded Knowledge
// Source (slug: uploaded-knowledge-source)". The tool description
// already instructs the agent to omit `name` in this case; this guard
// is the defensive belt for when the agent ignores the instruction.
// Case-insensitive on whole-string match so a legitimate name like
// "Uploaded API reference for vendor X" (which starts with the same
// word) survives.
const GENERIC_NAME_PATTERNS = [
  // "Uploaded …" family
  /^uploaded\s+knowledge\s+source$/i,
  /^uploaded\s+file$/i,
  /^uploaded\s+document$/i,
  /^uploaded\s+content$/i,
  // "New …" family — LLM "starting fresh" pattern
  /^new\s+knowledge\s+source$/i,
  /^new\s+file$/i,
  /^new\s+document$/i,
  // "Pasted …" family
  /^pasted\s+(content|text|document|file)$/i,
  // Single-word generics
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

// EXPORTED FOR TESTS — keep in sync with the production guard below.
export { isGenericName };

export const createKnowledgeSourceTool: ConversationTool = {
  name: "create_knowledge_source",
  description:
    "Ingest content as a tenant Knowledge Source. Accepts inline markdown/text/JSON (mode='inline' with name + content) or an existing conversation attachment (mode='from_attachment' with file_id). Supported file types: markdown, plaintext, JSON, YAML, XML, CSV, PDF, DOCX, XLSX, PPTX. For knowledge-source intents, sk uploads local files before the agent message is sent, so the prompt usually already contains a `{\"$file\":\"fid_…\"}` leaf — call mode='from_attachment' with that file_id. Use mode='inline' only for text the user pasted directly into chat. For mode='from_attachment', OMIT `name` unless the user explicitly named the source — the engine derives a clean name from the uploaded filename (e.g. `OCPP-2.0.1.md` → `OCPP-2.0.1`). NEVER invent generic placeholders like 'Uploaded Knowledge Source' or 'Attachment'.",
  use_case:
    'Use when the user asks to add a file, document, or pasted content as searchable knowledge. If the prompt contains a `{"$file":"fid_…"}` leaf, use mode=\'from_attachment\' with that file_id AND OMIT `name` so the engine uses the real filename. Only set `name` when the user explicitly typed one in the chat (e.g. "name it Internal API Docs"). For pasted text or LLM-generated content, use mode=\'inline\'. If the user mentions a path string but no fid_… is present, the file was not available to sk — ask the user to check the path rather than calling this tool with the raw path string as `content`.',
  important_notes: [
    "Re-runs with identical content are idempotent at the chunk level — the engine deduplicates.",
    "scope='workflow' requires workflow_id; omit both to default to global scope.",
    "mode='from_attachment' with no `name` argument is the common case — the engine derives the name from the file's filename. Passing a generic placeholder defeats the default and leaks into the slug and KS listings.",
    "Tenant has a global byte budget; very large files may be rejected with `budget_exceeded`.",
    "Omit `description`/`tags` to let the engine auto-generate them from the content; pass them only when the user dictates specific values.",
  ],
  example_input: {
    mode: "from_attachment",
    file_id: "fid_00000000-0000-0000-0000-000000000000",
    name: "OCPP 2.0.1 — Protocol reference",
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
      // .refine guarantees file_id is set; assert for the type narrowing.
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
      const resolved = resolvedFromRow(row);
      const stream = await resolved.openRead();
      buffer = await readAllBytes(stream);
      filename = resolved.filename;
      mime = resolved.content_type ?? undefined;
      // Prefer the user-supplied name, but fall through to the
      // filename-derived default when the agent passed a generic
      // placeholder it invented in the absence of filename context.
      name = args.name && !isGenericName(args.name) ? args.name : defaultNameFromFilename(filename);
      source_type_override = "file_upload";
      source_uri_override = filename;
    } else {
      // .refine guarantees name + content are set.
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

      // Interactive auto-enrich (best-effort): generate a description +
      // tags when the upload landed without them. Runs after the create
      // commits, outside its transaction. A failure (e.g. LlmQuotaExhausted)
      // leaves the source created/un-enriched and never fails the upload.
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
