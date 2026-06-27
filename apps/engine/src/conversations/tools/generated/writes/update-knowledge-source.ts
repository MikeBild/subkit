// update_knowledge_source — patch a persisted knowledge source's
// metadata (name, description, scope, status, refresh strategy).
// Generic patch shape; send only the fields that should change.
//
// Pattern parity with update_workflow / update_connector /
// update_schedule. Audit funnels through the existing
// `knowledge_source.updated` action — no new audit-action enum entry.

import { z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../../../auth/types.ts";
import { roles, systemAccounts, users } from "../../../../db/schema/index.ts";
import { can } from "../../../../rbac/evaluator.ts";
import type { ConversationTool, ToolContext } from "../../index.ts";

const UpdateKnowledgeSourceInput = z
  .object({
    id: z.string().uuid("knowledge source id must be a UUID"),
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
    tags: z.array(z.string().min(1).max(40)).max(20).optional(),
    scope: z.enum(["global", "workflow"]).optional(),
    workflow_id: z.string().uuid().nullable().optional(),
    status: z.enum(["active", "inactive"]).optional(),
    refresh_strategy: z.enum(["manual", "scheduled"]).optional(),
    refresh_cron: z.string().nullable().optional(),
  })
  .refine(
    (v) =>
      Boolean(
        v.name ||
          v.description ||
          v.tags !== undefined ||
          v.scope ||
          v.workflow_id !== undefined ||
          v.status ||
          v.refresh_strategy ||
          v.refresh_cron !== undefined,
      ),
    { message: "At least one patch field is required" },
  )
  .openapi("UpdateKnowledgeSourceToolInput");

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

export const updateKnowledgeSourceTool: ConversationTool = {
  name: "update_knowledge_source",
  description:
    "Patch a persisted knowledge source — rename, edit its description/tags, retarget the workflow scope, change status, or change refresh cadence.",
  use_case:
    "Use when the user asks to rename a knowledge source, set its description or tags, archive it (status='inactive'), repoint it to a different workflow scope, or change its refresh cadence. To auto-generate a description/tags from the content instead of dictating them, use analyze_knowledge_source. Send only the fields that should change.",
  important_notes: [
    "At least one patch field is required.",
    "Switching scope to 'workflow' requires workflow_id to be set (either in this patch or already on the row).",
    "Audits as knowledge_source.updated with full before/after snapshots — never overrides ingested chunk history.",
  ],
  inputSchema: UpdateKnowledgeSourceInput,
  category: "tenant_write",
  async execute(ctx, rawArgs) {
    const args = UpdateKnowledgeSourceInput.parse(rawArgs);
    // The dispatcher now owns MCP RBAC (RBAC_OVERRIDES); this in-execute
    // check stays because the chat surface invokes execute() directly and
    // does not route through the dispatcher's descriptor.rbac yet.
    const auth = await requirePermission(ctx, "knowledge:write", {
      type: "knowledge",
      id: args.id,
    });
    if (!auth.allow) return permissionDenied("knowledge:write", auth.reason);

    try {
      const view = await ctx.engineClient.knowledgeSources.update(args.id, {
        ...(args.name !== undefined ? { name: args.name } : {}),
        ...(args.description !== undefined ? { description: args.description } : {}),
        ...(args.tags !== undefined ? { tags: args.tags } : {}),
        ...(args.scope !== undefined ? { scope: args.scope } : {}),
        ...(args.workflow_id !== undefined ? { workflow_id: args.workflow_id } : {}),
        ...(args.status !== undefined ? { status: args.status } : {}),
        ...(args.refresh_strategy !== undefined ? { refresh_strategy: args.refresh_strategy } : {}),
        ...(args.refresh_cron !== undefined ? { refresh_cron: args.refresh_cron } : {}),
      });

      if (!view) {
        return { ok: false, data: { error: "knowledge_source_not_found", id: args.id } };
      }

      const audit_log_id = await ctx.engineClient.audit_write({
        resource_type: "knowledge_source",
        resource_id: view.id,
        action: "conversation.update_knowledge_source",
        result: "success",
        metadata: {
          conversation_id: ctx.conversation_id,
          fields: Object.keys(args).filter((k) => k !== "id"),
        },
      });

      return {
        ok: true,
        data: {
          updated: true,
          knowledge_source: {
            id: view.id,
            name: view.name,
            tags: view.tags,
            scope: view.scope,
            status: view.status,
          },
          audit_log_id,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("workflow_id is required when scope is 'workflow'")) {
        return { ok: false, data: { error: "scope_workflow_requires_workflow_id", message: msg } };
      }
      return { ok: false, data: { error: "update_failed", message: msg } };
    }
  },
};
