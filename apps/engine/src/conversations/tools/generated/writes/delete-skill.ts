// delete_skill — hard-delete a tenant Skill by id.
//
// Mirrors `delete_knowledge_source` (cleanup.ts): parse the id, call the
// engine-client `skills.delete` facet, emit a surface audit, and return the
// uniform { ok, data } envelope. The service hard-deletes the row (no
// soft-delete) — operators should prefer archiving the skill instead.
//
// The dispatcher now owns MCP RBAC (RBAC_OVERRIDES); the in-execute check
// below stays because the chat surface invokes execute() directly and does
// not route through the dispatcher's descriptor.rbac yet.

import { z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../../../auth/types.ts";
import { roles, systemAccounts, users } from "../../../../db/schema/index.ts";
import { can } from "../../../../rbac/evaluator.ts";
import type { ConversationTool, ToolContext, ToolResult } from "../../index.ts";

const DeleteSkillInput = z.object({ id: z.string().uuid() }).openapi("DeleteSkillToolInput");

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

export const deleteSkillTool: ConversationTool = {
  name: "delete_skill",
  description:
    "Hard-delete a skill by id — the row is permanently removed (prefer archiving instead). Requires confirmation first and records audit.",
  inputSchema: DeleteSkillInput,
  category: "tenant_write",
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = DeleteSkillInput.parse(rawArgs);

    const auth = await requirePermission(ctx, "skill:delete", { type: "skill", id: args.id });
    if (!auth.allow) return permissionDenied("skill:delete", auth.reason);

    try {
      const ok = await ctx.engineClient.skills.delete(args.id);
      if (!ok) {
        return {
          ok: false,
          data: { error: "not_found", message: `Skill ${args.id} not found` },
        };
      }

      const audit_log_id = await ctx.engineClient.audit_write({
        resource_type: "skill",
        resource_id: args.id,
        action: "conversation.delete_skill",
        result: "success",
        metadata: { conversation_id: ctx.conversation_id },
      });

      return {
        ok: true,
        data: {
          deleted: true,
          id: args.id,
          audit_log_id,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, data: { error: "delete_failed", message: msg } };
    }
  },
};
