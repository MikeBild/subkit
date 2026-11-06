import type { ResolvedPrincipal } from "../../auth/types.ts";
import {
  findRoleNameByRoleId,
  findSystemAccountRoleId,
  findUserRoleName,
} from "../../rbac/actor-roles.ts";
import { can } from "../../rbac/evaluator.ts";
import type { ApprovalAuditResource } from "../../tools/approval.ts";
import type { ConversationTool, ToolContext } from "./index.ts";

export async function resolveConversationPrincipal(
  ctx: ToolContext,
): Promise<ResolvedPrincipal | null> {
  const actorId = ctx.engineClient.context.actor_id;
  const actorType = ctx.engineClient.context.actor_type;
  if (!actorId || actorType === "system") return null;

  if (actorType === "user") {
    const row = await findUserRoleName(ctx.db, ctx.tenant_id, actorId);
    if (!row) return null;
    const roleNames = row.role_name ? [row.role_name] : [];
    return {
      provider: "conversation_tool",
      kind: "user",
      id: actorId,
      tenant_id: ctx.tenant_id,
      roles: roleNames,
    };
  }
  if (actorType === "system_account") {
    const row = await findSystemAccountRoleId(ctx.db, ctx.tenant_id, actorId);
    if (!row) return null;
    let roleNames: string[] = ["member"];
    if (row.role_id) {
      const name = await findRoleNameByRoleId(ctx.db, row.role_id);
      if (name) roleNames = [name];
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

export async function checkToolPermission(
  ctx: ToolContext,
  descriptor: NonNullable<ConversationTool["permission"]>,
  rawArgs: Record<string, unknown>,
  approval?: ApprovalAuditResource,
): Promise<ToolPermissionResult> {
  const principal = ctx.principal ?? (await resolveConversationPrincipal(ctx));
  if (!principal) return { allow: true };

  let resourceId: string;
  if (descriptor.resolveResourceId) {
    const resolved = await descriptor.resolveResourceId(ctx, rawArgs);
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

export async function checkTenantPermission(
  ctx: ToolContext,
  permission: string,
  audited: { type: string; id: string },
): Promise<ToolPermissionResult> {
  const principal = ctx.principal ?? (await resolveConversationPrincipal(ctx));
  if (!principal) return { allow: true };
  const decision = await can(ctx.db, { tenant_id: ctx.tenant_id, principal, permission });
  if (decision.allow) return { allow: true };
  const reason = decision.reason ?? `permission_denied:${permission}`;
  await recordPolicyDenied(ctx, permission, audited, reason, undefined);
  return { allow: false, reason, permission };
}
