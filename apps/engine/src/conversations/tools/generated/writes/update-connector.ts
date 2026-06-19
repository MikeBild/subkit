// update_connector — patch a persisted connector's metadata or
// authentication shape. Generic on purpose: send only the fields
// that should change. Drives both light edits ("rename to GitHub
// Prod") and structural edits (swap auth_type, repoint base_url).
//
// Pattern parity with update_workflow / update_schedule: bare field
// names, single tenant_write tool, audit funnels through the
// existing `connector.updated` action — no new audit-action enum
// entry, since the operation is still semantically a connector
// update.

import { z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../../../auth/types.ts";
import { roles, systemAccounts, users } from "../../../../db/schema/index.ts";
import { can } from "../../../../rbac/evaluator.ts";
import { translateAutoPersistError } from "../../../persistence/auto-persist.ts";
import type { ConversationTool, ToolContext } from "../../index.ts";

const UpdateConnectorInput = z
  .object({
    id: z.string().uuid("connector id must be a UUID"),
    name: z.string().min(1).optional(),
    base_url: z.string().url().optional(),
    dsn: z.string().min(1).optional(),
    auth_type: z.enum(["none", "bearer", "basic", "oauth2", "header"]).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    template_slug: z.string().min(1).optional(),
    clear_template_binding: z.boolean().optional(),
  })
  .refine(
    (v) =>
      Boolean(
        v.name ||
          v.base_url ||
          v.dsn ||
          v.auth_type ||
          v.config ||
          v.template_slug ||
          v.clear_template_binding,
      ),
    {
      message:
        "At least one of name, base_url, dsn, auth_type, config, template_slug, or clear_template_binding is required",
    },
  )
  .refine((v) => !(v.template_slug && v.clear_template_binding), {
    message: "template_slug and clear_template_binding are mutually exclusive",
  })
  .openapi("UpdateConnectorToolInput");

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

export const updateConnectorTool: ConversationTool = {
  name: "update_connector",
  description:
    "Patch a persisted connector — rename, repoint base_url, change auth_type, edit config, or swap the template binding. Sends only the fields that should change.",
  use_case:
    "Use when the user asks to rename a connector, change its URL, switch auth type, edit its config, or rebind it to a different template. Send only the fields that should change.",
  important_notes: [
    "At least one patch field is required (name, base_url, dsn, auth_type, config, template_slug, or clear_template_binding).",
    "template_slug and clear_template_binding are mutually exclusive.",
    "Audits as connector.updated with full before/after snapshots.",
    "Driver-level config validation runs before the write — invalid config is rejected with the validator's error.",
  ],
  inputSchema: UpdateConnectorInput,
  category: "tenant_write",
  async execute(ctx, rawArgs) {
    const args = UpdateConnectorInput.parse(rawArgs);
    const auth = await requirePermission(ctx, "connector:write", {
      type: "connector",
      id: args.id,
    });
    if (!auth.allow) return permissionDenied("connector:write", auth.reason);

    try {
      const view = await ctx.engineClient.connectors.update(args.id, {
        ...(args.name !== undefined ? { name: args.name } : {}),
        ...(args.base_url !== undefined ? { base_url: args.base_url } : {}),
        ...(args.dsn !== undefined ? { dsn: args.dsn } : {}),
        ...(args.auth_type !== undefined ? { auth_type: args.auth_type } : {}),
        ...(args.config !== undefined ? { config: args.config } : {}),
        ...(args.template_slug !== undefined ? { template_slug: args.template_slug } : {}),
        ...(args.clear_template_binding === true ? { clear_template_binding: true } : {}),
      });

      if (!view) {
        return { ok: false, data: { error: "connector_not_found", id: args.id } };
      }

      const audit_log_id = await ctx.engineClient.audit_write({
        resource_type: "connector",
        resource_id: view.id,
        action: "conversation.update_connector",
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
          connector: {
            id: view.id,
            slug: view.slug,
            display_name: view.display_name,
            driver: view.driver,
            environment: view.environment,
            auth_type: view.auth_type,
          },
          audit_log_id,
        },
      };
    } catch (err) {
      const code = (err as { code?: string }).code;
      const msg = err instanceof Error ? err.message : String(err);
      if (code === "connector_template_unknown" || code === "connector_template_conflict") {
        return { ok: false, data: { error: code, message: msg } };
      }
      // Translate Postgres errors (23505 unique-violation, 23503 fk
      // violation, 23502 not-null, 22P02 invalid uuid/enum) into the
      // same typed error_codes the auto-persist path uses, so the
      // LLM can recover via the structured `next_best_actions` hint
      // instead of getting a raw SQL string.
      const translated = translateAutoPersistError(err, "update_connector");
      return {
        ok: false,
        data: {
          error: translated.error_code,
          message: translated.message,
          next_best_actions: translated.next_best_actions,
        },
      };
    }
  },
};
