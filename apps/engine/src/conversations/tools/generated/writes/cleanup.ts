import { z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../../../auth/types.ts";
import { roles, systemAccounts, users } from "../../../../db/schema/index.ts";
import { logger } from "../../../../logging/logger.ts";
import { can } from "../../../../rbac/evaluator.ts";
import { tunnelRegistry } from "../../../../tunnels/registry.ts";
import { translateAutoPersistError } from "../../../persistence/auto-persist.ts";
import type { ConversationTool, ToolContext } from "../../index.ts";

const WorkflowDeleteInput = z
  .object({
    id: z.string().uuid("workflow id must be a UUID").optional(),
    slug: z.string().min(1).optional(),
  })
  .refine((v) => Boolean(v.id || v.slug), {
    message: "Either id or slug is required",
  })
  .openapi("DeleteWorkflowToolInput");

const IdInput = z.object({ id: z.string().uuid() }).openapi("CleanupIdToolInput");

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

async function recordPolicyDenied(
  ctx: ToolContext,
  permission: string,
  resource: { type: string; id: string },
  reason: string,
): Promise<string> {
  return await ctx.engineClient.audit_write({
    resource_type: resource.type,
    resource_id: resource.id,
    action: "policy.denied",
    result: "denied",
    reason,
    metadata: {
      permission,
      resource_type: resource.type,
      resource_id: resource.id,
      conversation_id: ctx.conversation_id,
    },
  });
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

  const reason = decision.reason ?? `permission_denied:${permission}`;
  await recordPolicyDenied(ctx, permission, resource, reason);
  return { allow: false, reason };
}

function permissionDenied(permission: string, reason: string) {
  return {
    ok: false as const,
    data: { error: "permission_denied", permission, reason },
  };
}

export const deleteWorkflowTool: ConversationTool = {
  name: "delete_workflow",
  description:
    "Soft-delete a workflow by id or slug. Requires confirmation first and records audit.",
  inputSchema: WorkflowDeleteInput,
  category: "tenant_write",
  async execute(ctx, rawArgs) {
    const args = WorkflowDeleteInput.parse(rawArgs);
    if (args.id) {
      const auth = await requirePermission(ctx, "workflow:delete", {
        type: "workflow",
        id: args.id,
      });
      if (!auth.allow) return permissionDenied("workflow:delete", auth.reason);
    }

    let workflow: Awaited<ReturnType<typeof ctx.engineClient.workflows.get>> | null = null;
    if (args.id) {
      workflow = await ctx.engineClient.workflows.get(args.id);
    } else if (args.slug) {
      workflow = await ctx.engineClient.workflows.getBySlug(args.slug);
    }
    if (!workflow) return { ok: false, data: { error: "workflow_not_found" } };

    if (!args.id) {
      const auth = await requirePermission(ctx, "workflow:delete", {
        type: "workflow",
        id: workflow.id,
      });
      if (!auth.allow) return permissionDenied("workflow:delete", auth.reason);
    }

    let ok: boolean;
    try {
      ok = await ctx.engineClient.workflows.delete(workflow.id);
    } catch (err) {
      // Translate Postgres errors (FK violations from running
      // executions, schedules, hooks) into typed error_codes.
      const translated = translateAutoPersistError(err, "delete_workflow");
      logger.warn({
        module: "conversation_tool",
        action: "delete_workflow.threw",
        tenant_id: ctx.tenant_id,
        conversation_id: ctx.conversation_id,
        workflow_id: workflow.id,
        error_code: translated.error_code,
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        ok: false,
        data: {
          error: translated.error_code,
          message: translated.message,
          next_best_actions: translated.next_best_actions,
        },
      };
    }
    if (!ok) {
      const audit_log_id = await ctx.engineClient.audit_write({
        resource_type: "workflow",
        resource_id: workflow.id,
        action: "conversation.delete_workflow",
        result: "error",
        reason: "workflow_not_found",
        metadata: { conversation_id: ctx.conversation_id, workflow_slug: workflow.slug },
      });
      return { ok: false, data: { error: "workflow_not_found", audit_log_id } };
    }
    const audit_log_id = await ctx.engineClient.audit_write({
      resource_type: "workflow",
      resource_id: workflow.id,
      action: "conversation.delete_workflow",
      result: "success",
      metadata: {
        conversation_id: ctx.conversation_id,
        workflow_slug: workflow.slug,
        workflow_name: workflow.name,
      },
    });
    return {
      ok: true,
      data: {
        deleted: true,
        workflow: { id: workflow.id, slug: workflow.slug, name: workflow.name },
        audit_log_id,
      },
    };
  },
};

export const deleteConnectorTool: ConversationTool = {
  name: "delete_connector",
  description: "Soft-delete a connector by id. Requires confirmation first and records audit.",
  inputSchema: IdInput,
  category: "tenant_write",
  async execute(ctx, rawArgs) {
    const args = IdInput.parse(rawArgs);
    const auth = await requirePermission(ctx, "connector:delete", {
      type: "connector",
      id: args.id,
    });
    if (!auth.allow) return permissionDenied("connector:delete", auth.reason);

    const connector = await ctx.engineClient.connectors.get(args.id);
    if (!connector) return { ok: false, data: { error: "connector_not_found" } };

    let ok: boolean;
    try {
      ok = await ctx.engineClient.connectors.delete(connector.id);
    } catch (err) {
      const translated = translateAutoPersistError(err, "delete_connector");
      logger.warn({
        module: "conversation_tool",
        action: "delete_connector.threw",
        tenant_id: ctx.tenant_id,
        conversation_id: ctx.conversation_id,
        connector_id: connector.id,
        error_code: translated.error_code,
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        ok: false,
        data: {
          error: translated.error_code,
          message: translated.message,
          next_best_actions: translated.next_best_actions,
        },
      };
    }
    if (!ok) {
      const audit_log_id = await ctx.engineClient.audit_write({
        resource_type: "connector",
        resource_id: connector.id,
        action: "conversation.delete_connector",
        result: "error",
        reason: "connector_not_found",
        metadata: { conversation_id: ctx.conversation_id, connector_slug: connector.slug },
      });
      return { ok: false, data: { error: "connector_not_found", audit_log_id } };
    }
    const audit_log_id = await ctx.engineClient.audit_write({
      resource_type: "connector",
      resource_id: connector.id,
      action: "conversation.delete_connector",
      result: "success",
      metadata: {
        conversation_id: ctx.conversation_id,
        connector_slug: connector.slug,
        connector_name: connector.display_name,
      },
    });
    return {
      ok: true,
      data: {
        deleted: true,
        connector: { id: connector.id, slug: connector.slug, display_name: connector.display_name },
        audit_log_id,
      },
    };
  },
};

export const deleteKnowledgeSourceTool: ConversationTool = {
  name: "delete_knowledge_source",
  description:
    "Soft-delete a knowledge source by id. Requires confirmation first and records audit.",
  inputSchema: IdInput,
  category: "tenant_write",
  async execute(ctx, rawArgs) {
    const args = IdInput.parse(rawArgs);
    const auth = await requirePermission(ctx, "knowledge:delete", {
      type: "knowledge_source",
      id: args.id,
    });
    if (!auth.allow) return permissionDenied("knowledge:delete", auth.reason);

    const source = await ctx.engineClient.knowledgeSources.get(args.id);
    if (!source) return { ok: false, data: { error: "knowledge_source_not_found" } };

    const ok = await ctx.engineClient.knowledgeSources.delete(source.id);
    if (!ok) {
      const audit_log_id = await ctx.engineClient.audit_write({
        resource_type: "knowledge_source",
        resource_id: source.id,
        action: "conversation.delete_knowledge_source",
        result: "error",
        reason: "knowledge_source_not_found",
        metadata: { conversation_id: ctx.conversation_id, knowledge_source_slug: source.slug },
      });
      return { ok: false, data: { error: "knowledge_source_not_found", audit_log_id } };
    }
    const audit_log_id = await ctx.engineClient.audit_write({
      resource_type: "knowledge_source",
      resource_id: source.id,
      action: "conversation.delete_knowledge_source",
      result: "success",
      metadata: {
        conversation_id: ctx.conversation_id,
        knowledge_source_slug: source.slug,
        knowledge_source_name: source.name,
      },
    });
    return {
      ok: true,
      data: {
        deleted: true,
        knowledge_source: { id: source.id, slug: source.slug, name: source.name },
        audit_log_id,
      },
    };
  },
};

export const deleteSubscriptionTool: ConversationTool = {
  name: "delete_subscription",
  description:
    "Delete an outbound webhook subscription by id. Requires confirmation first and records audit.",
  inputSchema: IdInput,
  category: "tenant_write",
  async execute(ctx, rawArgs) {
    const args = IdInput.parse(rawArgs);
    const auth = await requirePermission(ctx, "subscription:delete", {
      type: "subscription",
      id: args.id,
    });
    if (!auth.allow) return permissionDenied("subscription:delete", auth.reason);

    const subscription = await ctx.engineClient.subscriptions.get(args.id);
    if (!subscription) return { ok: false, data: { error: "subscription_not_found" } };

    const ok = await ctx.engineClient.subscriptions.delete(subscription.id);
    if (!ok) {
      const audit_log_id = await ctx.engineClient.audit_write({
        resource_type: "subscription",
        resource_id: subscription.id,
        action: "conversation.delete_subscription",
        result: "error",
        reason: "subscription_not_found",
        metadata: { conversation_id: ctx.conversation_id },
      });
      return { ok: false, data: { error: "subscription_not_found", audit_log_id } };
    }
    const audit_log_id = await ctx.engineClient.audit_write({
      resource_type: "subscription",
      resource_id: subscription.id,
      action: "conversation.delete_subscription",
      result: "success",
      metadata: {
        conversation_id: ctx.conversation_id,
        event_pattern: subscription.event_pattern,
      },
    });
    return {
      ok: true,
      data: {
        deleted: true,
        subscription: {
          id: subscription.id,
          event_pattern: subscription.event_pattern,
          target_url: subscription.target_url,
        },
        audit_log_id,
      },
    };
  },
};

export const deleteTunnelTool: ConversationTool = {
  name: "delete_tunnel",
  description: "Unregister a tunnel by id. Requires confirmation first and records audit.",
  inputSchema: IdInput,
  category: "tenant_write",
  async execute(ctx, rawArgs) {
    const args = IdInput.parse(rawArgs);
    const auth = await requirePermission(ctx, "tunnel:delete", {
      type: "tunnel",
      id: args.id,
    });
    if (!auth.allow) return permissionDenied("tunnel:delete", auth.reason);

    const tunnel = await ctx.engineClient.tunnels.get(args.id);
    if (!tunnel) return { ok: false, data: { error: "tunnel_not_found" } };

    for (const target of tunnel.targets) {
      tunnelRegistry.detach(ctx.tenant_id, target.target_name);
    }
    const ok = await ctx.engineClient.tunnels.delete(tunnel.id);
    if (!ok) {
      const audit_log_id = await ctx.engineClient.audit_write({
        resource_type: "tunnel",
        resource_id: tunnel.id,
        action: "conversation.delete_tunnel",
        result: "error",
        reason: "tunnel_not_found",
        metadata: { conversation_id: ctx.conversation_id, tunnel_name: tunnel.name },
      });
      return { ok: false, data: { error: "tunnel_not_found", audit_log_id } };
    }
    const audit_log_id = await ctx.engineClient.audit_write({
      resource_type: "tunnel",
      resource_id: tunnel.id,
      action: "conversation.delete_tunnel",
      result: "success",
      metadata: {
        conversation_id: ctx.conversation_id,
        tunnel_name: tunnel.name,
        target_count: tunnel.targets.length,
      },
    });
    return {
      ok: true,
      data: {
        deleted: true,
        tunnel: { id: tunnel.id, name: tunnel.name, target_count: tunnel.targets.length },
        audit_log_id,
      },
    };
  },
};

export const revokeApiKeyTool: ConversationTool = {
  name: "revoke_api_key",
  description: "Revoke an API key by id. Requires confirmation first and records audit.",
  inputSchema: IdInput,
  category: "tenant_write",
  async execute(ctx, rawArgs) {
    const args = IdInput.parse(rawArgs);
    const auth = await requirePermission(ctx, "api_key:revoke", {
      type: "api_key",
      id: args.id,
    });
    if (!auth.allow) return permissionDenied("api_key:revoke", auth.reason);

    const apiKey = await ctx.engineClient.identity.getApiKey(args.id);
    if (!apiKey) return { ok: false, data: { error: "api_key_not_found" } };

    const revoked = await ctx.engineClient.identity.revokeApiKey(args.id);
    if (!revoked) {
      const audit_log_id = await ctx.engineClient.audit_write({
        resource_type: "api_key",
        resource_id: args.id,
        action: "conversation.revoke_api_key",
        result: "error",
        reason: "api_key_not_found",
        metadata: { conversation_id: ctx.conversation_id, prefix: apiKey.prefix },
      });
      return { ok: false, data: { error: "api_key_not_found", audit_log_id } };
    }
    const audit_log_id = await ctx.engineClient.audit_write({
      resource_type: "api_key",
      resource_id: revoked.id,
      action: "conversation.revoke_api_key",
      result: "success",
      metadata: { conversation_id: ctx.conversation_id, prefix: revoked.prefix },
    });
    return {
      ok: true,
      data: {
        revoked: true,
        api_key: { id: revoked.id, prefix: revoked.prefix, revoked_at: revoked.revoked_at },
        audit_log_id,
      },
    };
  },
};

export const revokePortalTokenTool: ConversationTool = {
  name: "revoke_portal_token",
  description: "Revoke a portal token by id. Requires confirmation first and records audit.",
  inputSchema: IdInput,
  category: "tenant_write",
  async execute(ctx, rawArgs) {
    const args = IdInput.parse(rawArgs);
    const auth = await requirePermission(ctx, "portal_token:revoke", {
      type: "portal_token",
      id: args.id,
    });
    if (!auth.allow) return permissionDenied("portal_token:revoke", auth.reason);

    const revoked = await ctx.engineClient.identity.revokePortalToken(args.id);
    if (!revoked) {
      const audit_log_id = await ctx.engineClient.audit_write({
        resource_type: "portal_token",
        resource_id: args.id,
        action: "conversation.revoke_portal_token",
        result: "error",
        reason: "portal_token_not_found",
        metadata: { conversation_id: ctx.conversation_id },
      });
      return { ok: false, data: { error: "portal_token_not_found", audit_log_id } };
    }
    const audit_log_id = await ctx.engineClient.audit_write({
      resource_type: "portal_token",
      resource_id: revoked.id,
      action: "conversation.revoke_portal_token",
      result: "success",
      metadata: {
        conversation_id: ctx.conversation_id,
        prefix: revoked.prefix,
        enduser_ref: revoked.enduser_ref,
      },
    });
    return {
      ok: true,
      data: {
        revoked: true,
        portal_token: {
          id: revoked.id,
          prefix: revoked.prefix,
          enduser_ref: revoked.enduser_ref,
          revoked_at: revoked.revoked_at,
        },
        audit_log_id,
      },
    };
  },
};

export const cleanupWriteTools: ConversationTool[] = [
  deleteWorkflowTool,
  deleteConnectorTool,
  deleteKnowledgeSourceTool,
  deleteSubscriptionTool,
  deleteTunnelTool,
  revokeApiKeyTool,
  revokePortalTokenTool,
];
