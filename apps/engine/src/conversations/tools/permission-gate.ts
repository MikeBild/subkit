// Central RBAC gate for conversation tools.
//
// Every write tool used to hand-roll `resolveConversationPrincipal(ctx) +
// can(...)` at the top of its `execute`, plus a private copy of the principal
// resolver. This module is the single home for both: `wrapOne` enforces a
// tool's declarative `permission` descriptor here BEFORE `inner.execute`, so
// the per-tool boilerplate is gone and the (action, resourceType, resourceId)
// mapping lives on the tool definition instead of buried in its body.
//
// The dispatcher (`tools/dispatcher.ts`) has its OWN RBAC layer for the direct
// MCP surface; this gate is the conversation-loop (chat) path enforcement.

import { and, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { roles, systemAccounts, users } from "../../db/schema/index.ts";
import { can } from "../../rbac/evaluator.ts";
import type { ConversationTool, ToolContext } from "./index.ts";

/**
 * Resolve the acting principal from the conversation's engine context
 * (`actor_id` / `actor_type`), loading its role name(s). Returns `null` for
 * system / unauthenticated actors — callers treat null as "allow" (system
 * work is trusted; RBAC governs user/system-account principals).
 */
export async function resolveConversationPrincipal(
  ctx: ToolContext,
): Promise<ResolvedPrincipal | null> {
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

export type ToolPermissionResult =
  | { allow: true }
  | { allow: false; reason: string; permission: string };

/**
 * Enforce a tool's declarative `permission` descriptor. Resolves the resource
 * id from `rawArgs[resourceIdArg]` (falling back to `"*"` for create-style
 * gates), resolves the principal, and calls `can()`. A null principal is
 * allowed. The returned `reason`/`permission` feed the tool's
 * `permission_denied` envelope on deny.
 */
export async function checkToolPermission(
  ctx: ToolContext,
  descriptor: NonNullable<ConversationTool["permission"]>,
  rawArgs: Record<string, unknown>,
): Promise<ToolPermissionResult> {
  const principal = await resolveConversationPrincipal(ctx);
  if (!principal) return { allow: true };
  const resourceId = descriptor.resourceIdArg
    ? String(rawArgs[descriptor.resourceIdArg] ?? "*")
    : "*";
  const decision = await can(ctx.db, {
    tenant_id: ctx.tenant_id,
    principal,
    permission: descriptor.action,
    resource: { type: descriptor.resourceType, id: resourceId },
  });
  if (decision.allow) return { allow: true };
  return {
    allow: false,
    reason: decision.reason ?? `permission_denied:${descriptor.action}`,
    permission: descriptor.action,
  };
}
