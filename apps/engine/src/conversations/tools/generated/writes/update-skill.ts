// update_skill — patch a persisted tenant Skill's authored content
// (title, body, examples, activation rules, gated tools, lifecycle).
// Generic patch shape; send only the fields that should change.
//
// Pattern parity with update_knowledge_source / update_workflow.
//
// The dispatcher now owns MCP RBAC (RBAC_OVERRIDES); the in-execute check
// below stays because the chat surface invokes execute() directly and does
// not route through the dispatcher's descriptor.rbac yet. Audit funnels
// through the conversation.update_skill action with full before/after
// snapshots.

import { z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../../../auth/types.ts";
import { roles, systemAccounts, users } from "../../../../db/schema/index.ts";
import { can } from "../../../../rbac/evaluator.ts";
import { UpdateSkillSchema } from "../../../../skills/types.ts";
import type { ConversationTool, ToolContext } from "../../index.ts";

const UpdateSkillInput = z
  .object({ id: z.string().uuid() })
  .merge(UpdateSkillSchema)
  .openapi("UpdateSkillToolInput");

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

export const updateSkillTool: ConversationTool = {
  name: "update_skill",
  description:
    "Patch a persisted tenant Skill — edit its title/body, examples, best practices, pitfalls, doc refs, gated tools, activation rules, I/O schemas, side-effect/idempotency/maturity metadata, tags, or lifecycle status. Send only the fields that should change.",
  use_case:
    "Use when the user asks to rename a skill, revise its guidance, adjust when it activates, change which tools it gates, or change its lifecycle status. Send only the fields that should change.",
  important_notes: [
    "Send only the fields you want to change — omitted fields are left untouched.",
    "Audits as conversation.update_skill with full before/after snapshots.",
  ],
  inputSchema: UpdateSkillInput,
  category: "tenant_write",
  async execute(ctx, rawArgs) {
    const args = UpdateSkillInput.parse(rawArgs);
    const { id, ...patch } = args;

    const auth = await requirePermission(ctx, "skill:write", { type: "skill", id });
    if (!auth.allow) return permissionDenied("skill:write", auth.reason);

    try {
      const before = await ctx.engineClient.skills.get(id);
      const skill = await ctx.engineClient.skills.update(id, patch);

      if (!skill) {
        return {
          ok: false,
          data: { error: "not_found", message: `Skill ${id} not found` },
        };
      }

      const audit_log_id = await ctx.engineClient.audit_write({
        resource_type: "skill",
        resource_id: id,
        action: "conversation.update_skill",
        result: "success",
        metadata: {
          conversation_id: ctx.conversation_id,
          fields: Object.keys(patch),
          before: before ?? null,
          after: skill,
        },
      });

      return {
        ok: true,
        data: {
          updated: true,
          skill,
          audit_log_id,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, data: { error: "update_failed", message: msg } };
    }
  },
};
