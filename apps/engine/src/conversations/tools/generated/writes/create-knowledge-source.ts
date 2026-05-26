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
import { and, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../../../auth/types.ts";
import { roles, systemAccounts, users } from "../../../../db/schema/index.ts";
import type { FileRow } from "../../../../files/resolver.ts";
import { requireFileForTenant, resolvedFromRow } from "../../../../files/resolver.ts";
import { KnowledgeBudgetExceededError } from "../../../../knowledge/budgets.ts";
import { can } from "../../../../rbac/evaluator.ts";
import type { ConversationTool, ToolContext, ToolResult } from "../../index.ts";

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
    scope: z.string(),
    status: z.string(),
    chunk_count: z.number(),
    bytes_total: z.number(),
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

type PermissionResult = { allow: true } | { allow: false; reason: string };

async function resolveConversationPrincipal(ctx: ToolContext): Promise<ResolvedPrincipal | null> {
  const actorId = ctx.engineClient.context.actor_id;
  const actorType = ctx.engineClient.context.actor_type;
  if (!actorId || actorType === "system") return null;

  if (actorType === "user") {
    const rows = await ctx.db
      .select({ role: users.role, role_id: users.role_id })
      .from(users)
      .where(and(eq(users.id, actorId), eq(users.tenant_id, ctx.tenant_id)))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    let roleNames: string[] = [row.role];
    if (row.role_id) {
      // tenant-filter:exempt — RBAC catalog walk by role_id; handles both global rows (tenant_id IS NULL) and tenant rows
      const named = await ctx.db
        .select({ name: roles.name })
        .from(roles)
        .where(eq(roles.id, row.role_id))
        .limit(1);
      if (named[0]?.name) roleNames = [named[0].name];
    }
    return {
      provider: "conversation_tool",
      kind: "user",
      id: actorId,
      tenant_id: ctx.tenant_id,
      roles: roleNames,
    };
  }
  if (actorType === "system_account") {
    const rows = await ctx.db
      .select({ role_id: systemAccounts.role_id })
      .from(systemAccounts)
      .where(and(eq(systemAccounts.id, actorId), eq(systemAccounts.tenant_id, ctx.tenant_id)))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    let roleNames: string[] = ["member"];
    if (row.role_id) {
      // tenant-filter:exempt — RBAC catalog walk by role_id
      const named = await ctx.db
        .select({ name: roles.name })
        .from(roles)
        .where(eq(roles.id, row.role_id))
        .limit(1);
      if (named[0]?.name) roleNames = [named[0].name];
    }
    return {
      provider: "conversation_tool",
      kind: "system_account",
      id: actorId,
      tenant_id: ctx.tenant_id,
      roles: roleNames,
    };
  }
  return null;
}

async function requirePermission(
  ctx: ToolContext,
  permission: string,
  resource: { type: string; id: string },
): Promise<PermissionResult> {
  const principal = await resolveConversationPrincipal(ctx);
  if (!principal) return { allow: true };
  const decision = await can(ctx.db, {
    tenant_id: ctx.tenant_id,
    principal,
    permission,
    resource,
  });
  if (decision.allow) return { allow: true };
  return { allow: false, reason: decision.reason ?? `permission_denied:${permission}` };
}

function permissionDenied(permission: string, reason: string) {
  return {
    ok: false as const,
    data: { error: "permission_denied", permission, reason },
  };
}

async function readAllBytes(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function defaultNameFromFilename(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, "");
  return base.length > 0 ? base : filename;
}

export const createKnowledgeSourceTool: ConversationTool = {
  name: "create_knowledge_source",
  description:
    "Ingest content as a tenant Knowledge Source. Accepts inline markdown/text/JSON (mode='inline' with name + content) or an existing conversation attachment (mode='from_attachment' with file_id from /attach). Supported file types: markdown, plaintext, JSON, YAML, XML, CSV, PDF, DOCX, XLSX, PPTX. For local files, prefer the sk slash `/knowledge <path>` (one-shot upload + ingest, no model turn). Only call this tool when you already have a fid_… (from /attach) or inline content the user pasted into chat.",
  use_case:
    "Use when the user asks to add a file, document, or pasted content as searchable knowledge. If the user just uploaded an attachment with /attach, use mode='from_attachment' with that file_id. For pasted text or LLM-generated content, use mode='inline'. If the user provided a local filesystem path string (starts with /, ~, or ./) and you don't already have a fid_…, do NOT call this tool — direct them to run `/knowledge <path>` in sk instead.",
  important_notes: [
    "Re-runs with identical content are idempotent at the chunk level — the engine deduplicates.",
    "scope='workflow' requires workflow_id; omit both to default to global scope.",
    "Tenant has a global byte budget; very large files may be rejected with `budget_exceeded`.",
  ],
  example_input: {
    mode: "from_attachment",
    file_id: "fid_00000000-0000-0000-0000-000000000000",
    name: "OCPP 2.0.1 — Protocol reference",
  },
  inputSchema: CreateKnowledgeSourceInput,
  category: "tenant_write",
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = CreateKnowledgeSourceInput.parse(rawArgs);

    const auth = await requirePermission(ctx, "knowledge_source:write", {
      type: "knowledge_source",
      id: "*",
    });
    if (!auth.allow) return permissionDenied("knowledge_source:write", auth.reason);

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
      name = args.name ?? defaultNameFromFilename(filename);
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
      const view = await ctx.engineClient.knowledgeSources.create({
        input: {
          name,
          ...(args.description !== undefined ? { description: args.description } : {}),
          ...(args.scope !== undefined ? { scope: args.scope } : {}),
          ...(args.workflow_id !== undefined ? { workflow_id: args.workflow_id } : {}),
        },
        upload: { buffer, filename, ...(mime ? { mime } : {}) },
        source_type_override,
        source_uri_override,
      });

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

      return {
        ok: true,
        data: {
          created: true,
          knowledge_source: {
            id: view.id,
            name: view.name,
            slug: view.slug,
            scope: view.scope,
            status: view.status,
            chunk_count: view.chunk_count,
            bytes_total: view.bytes_total,
          },
          audit_log_id,
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
