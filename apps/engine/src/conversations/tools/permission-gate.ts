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
import type { ApprovalAuditResource } from "../../tools/approval.ts";
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
 * Write a `policy.denied` audit row for a conversation-tool RBAC deny. Mirrors
 * the dispatcher's `emitPolicyDenied` (MCP surface) so the chat path has audit
 * parity — every deny is recorded against the resolved resource.
 *
 * When the denied call is the confirmed replay of an approval whose single-use
 * handle is already burned, the row anchors on the approval lifecycle instead,
 * so "approval opened → confirmed replay denied" is one JOIN rather than two
 * unrelated rows. The RBAC resource moves into metadata; nothing is lost.
 */
async function recordPolicyDenied(
  ctx: ToolContext,
  permission: string,
  resource: { type: string; id: string },
  reason: string,
  approval: ApprovalAuditResource | undefined,
): Promise<void> {
  await ctx.engineClient.audit_write({
    resource_type: approval?.resource_type ?? resource.type,
    resource_id: approval?.approval_id ?? resource.id,
    action: "policy.denied",
    result: "denied",
    reason,
    metadata: {
      permission,
      resource_type: resource.type,
      resource_id: resource.id,
      conversation_id: ctx.conversation_id,
      ...(approval ? { approval_id: approval.approval_id } : {}),
    },
  });
}

/**
 * Enforce a tool's declarative `permission` descriptor. Resolves the principal
 * (null → allow), derives the resource id by the precedence documented on
 * `ConversationTool.permission` (`resolveResourceId` → `resourceIdArg` → `"*"`),
 * calls `can()`, and on deny writes a `policy.denied` audit row. The returned
 * `reason`/`permission` feed the tool's `permission_denied` envelope.
 *
 * `approval` is set only when this call replays a burned approval — the deny is
 * then the terminal row of that approval's lifecycle.
 */
export async function checkToolPermission(
  ctx: ToolContext,
  descriptor: NonNullable<ConversationTool["permission"]>,
  rawArgs: Record<string, unknown>,
  approval?: ApprovalAuditResource,
): Promise<ToolPermissionResult> {
  const principal = await resolveConversationPrincipal(ctx);
  if (!principal) return { allow: true };

  let resourceId: string;
  if (descriptor.resolveResourceId) {
    const resolved = await descriptor.resolveResourceId(ctx, rawArgs);
    // null → the resource couldn't be resolved (e.g. slug not found): defer to
    // the tool so it emits its own not_found instead of a confusing deny.
    if (resolved === null) return { allow: true };
    resourceId = resolved;
  } else {
    resourceId = descriptor.resourceIdArg ? String(rawArgs[descriptor.resourceIdArg] ?? "*") : "*";
  }

  const resource = { type: descriptor.resourceType, id: resourceId };
  const decision = await can(ctx.db, {
    tenant_id: ctx.tenant_id,
    principal,
    permission: descriptor.action,
    resource,
  });
  if (decision.allow) return { allow: true };

  const reason = decision.reason ?? `permission_denied:${descriptor.action}`;
  await recordPolicyDenied(ctx, descriptor.action, resource, reason, approval);
  return { allow: false, reason, permission: descriptor.action };
}
