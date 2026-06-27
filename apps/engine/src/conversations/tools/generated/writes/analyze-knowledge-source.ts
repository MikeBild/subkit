// analyze_knowledge_source — LLM-enrich a persisted Knowledge Source's
// metadata (description + topical tags). Reuses the same
// `analyzeKnowledgeSource` service path the interactive upload sites and
// the HTTP `POST /:id/analyze` route call.
//
// Pattern parity with create_knowledge_source / update_knowledge_source:
// `category: "tenant_write"`, inline `knowledge:write` RBAC check, an
// audit_log row before returning. NEVER renames name/slug — analysis
// enriches metadata only. `tags` are a deduped REPLACEMENT set; the
// description is overwritten only when currently null OR force=true.

import { z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../../../auth/types.ts";
import { roles, systemAccounts, users } from "../../../../db/schema/index.ts";
import { can } from "../../../../rbac/evaluator.ts";
import type { ConversationTool, ToolContext } from "../../index.ts";

const AnalyzeKnowledgeSourceInput = z
  .object({
    id: z.string().uuid("knowledge source id must be a UUID"),
    // Overwrite an existing description; otherwise only a null description
    // is filled. Tags are always replaced with the freshly generated set.
    force: z.boolean().optional(),
  })
  .openapi("AnalyzeKnowledgeSourceToolInput");

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

export const analyzeKnowledgeSourceTool: ConversationTool = {
  name: "analyze_knowledge_source",
  description:
    "Generate a description and topical tags for a persisted Knowledge Source by reading its first chunks. Use this to make a legacy source (uploaded without a description, or with no tags) self-describing and routable. Tags are replaced with a freshly generated set; the description is only overwritten when force=true.",
  use_case:
    "Use when the user asks to summarise, describe, tag, or 're-analyze' an existing Knowledge Source, or when list_knowledge_sources shows a source with a null description / empty tags. Pass force=true to regenerate an existing description.",
  important_notes: [
    "Never renames the source — analysis enriches description + tags only.",
    "tags are a deduped replacement set (3-8 short topical tags).",
    "description is overwritten only when currently empty or force=true.",
    "Counts against the tenant LLM budget; one model call per analyze.",
  ],
  inputSchema: AnalyzeKnowledgeSourceInput,
  category: "tenant_write",
  async execute(ctx, rawArgs) {
    const args = AnalyzeKnowledgeSourceInput.parse(rawArgs);
    // The dispatcher now owns MCP RBAC (RBAC_OVERRIDES); this in-execute
    // check stays because the chat surface invokes execute() directly and
    // does not route through the dispatcher's descriptor.rbac yet.
    const auth = await requirePermission(ctx, "knowledge:write", {
      type: "knowledge",
      id: args.id,
    });
    if (!auth.allow) return permissionDenied("knowledge:write", auth.reason);

    try {
      const view = await ctx.engineClient.knowledgeSources.analyze(args.id, {
        ...(args.force !== undefined ? { force: args.force } : {}),
      });

      if (!view) {
        return { ok: false, data: { error: "knowledge_source_not_found", id: args.id } };
      }

      const audit_log_id = await ctx.engineClient.audit_write({
        resource_type: "knowledge_source",
        resource_id: view.id,
        action: "conversation.analyze_knowledge_source",
        result: "success",
        metadata: {
          conversation_id: ctx.conversation_id,
          tags: view.tags,
          force: args.force === true,
        },
      });

      return {
        ok: true,
        data: {
          analyzed: true,
          knowledge_source: {
            id: view.id,
            name: view.name,
            description: view.description,
            tags: view.tags,
            status: view.status,
          },
          audit_log_id,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, data: { error: "analyze_failed", message: msg } };
    }
  },
};
