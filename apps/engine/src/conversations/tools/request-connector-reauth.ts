// `request_connector_reauth` — recovery affordance for a dead connector
// credential.
//
// When a connector's credential goes stale (OAuth refresh_token revoked,
// static API key rotated upstream, login lapsed), the connector is flagged
// `needs_reauth` and authed calls come back `health:auth_failed`. This tool
// turns that dead-end into a one-click fix: it resolves the "where do I click
// to reconnect" URL via `buildReauthUrl` and hands it back so the LLM can pass
// the link straight to the operator.
//
// Resolution:
//   - `connector_id` (uuid) takes precedence.
//   - `slug` resolves to the connector via the connectors list when
//     `connector_id` is omitted.
//   - both omitted ⇒ `invalid_input` asking for one.
//
// RBAC: `connector:read` on the target connector — same gate + resolution
// pattern `call_connector` uses (resolveConversationPrincipal + can(...)). A
// principal that cannot read the connector cannot mint its reauth link.
//
// This is NOT a skill-gated tool: a broken credential can surface in any
// conversation, so the recovery path must always be reachable.

import { z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { buildReauthUrl } from "../../connectors/reauth.ts";
import { getConnector } from "../../connectors/service.ts";
import { roles, systemAccounts, users } from "../../db/schema/index.ts";
import { logger } from "../../logging/logger.ts";
import { can } from "../../rbac/evaluator.ts";
import type { ConversationTool, ToolContext, ToolResult } from "./index.ts";

const RequestConnectorReauthInput = z
  .object({
    connector_id: z
      .string()
      .uuid("connector_id must be a UUID")
      .optional()
      .describe("Exact connector id; takes precedence over slug."),
    slug: z
      .string()
      .min(1)
      .optional()
      .describe("Connector slug; resolved to an id when connector_id is omitted."),
  })
  .openapi("RequestConnectorReauthToolInput");

// ---- RBAC (mirrors call-connector.ts) --------------------------------------

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

function structuredError(
  error_code: string,
  message: string,
  extra: Record<string, unknown> = {},
): ToolResult {
  return {
    ok: false,
    error_code,
    message,
    ...extra,
  };
}

// ---- the tool --------------------------------------------------------------

export const requestConnectorReauthTool: ConversationTool = {
  name: "request_connector_reauth",
  description:
    "Return a one-click link to reconnect a connector whose credential is dead. Call this when a connector is flagged `needs_reauth`, or when a `call_connector` / `probe_connector` result came back `health: auth_failed` — then hand the returned `reauth_url` to the user so they can re-authenticate. Resolves by `connector_id` (uuid) or `slug`.",
  use_case:
    "A saved connector's credential was revoked or rotated upstream and calls now fail with auth_failed — request_connector_reauth mints the reconnect link (OAuth authorize URL or credential-setup deep link) for the user to click.",
  important_notes: [
    "Pass either `connector_id` (uuid) or `slug`; `connector_id` wins when both are given.",
    "`method` is `oauth2` (a provider authorize URL, expires in ~10 minutes) or `portal_setup` (a credential-setup deep link).",
    "`reauth_url` is null only when the engine has no public origin configured — surface the `instructions` to the operator in that case.",
    "Read-only recovery affordance: it mints a link, it does not change credentials. Requires `connector:read` on the connector.",
  ],
  example_input: { slug: "digitalocean" },
  inputSchema: RequestConnectorReauthInput,
  category: "tenant_read",
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = RequestConnectorReauthInput.parse(rawArgs);

    if (!args.connector_id && !args.slug) {
      return structuredError(
        "invalid_input",
        "pass either `connector_id` (uuid) or `slug` to identify the connector to reconnect",
        { next_best_actions: ["find_connector", "list_connectors"] },
      );
    }

    // Resolve slug → id when connector_id is omitted.
    let connectorId = args.connector_id ?? null;
    if (!connectorId && args.slug) {
      const list = await ctx.engineClient.connectors.list();
      const match = list.find((c) => c.slug === args.slug);
      if (!match) {
        return structuredError("connector_not_found", `no connector with slug '${args.slug}'`, {
          next_best_actions: ["find_connector", "list_connectors"],
        });
      }
      connectorId = match.id;
    }

    // Narrowed: the early guard above rejects the both-missing case, and slug
    // resolution either sets connectorId or returns. This makes connectorId a
    // plain string for the rest of the flow (no non-null assertions).
    if (!connectorId) {
      return structuredError(
        "invalid_input",
        "pass either `connector_id` (uuid) or `slug` to identify the connector to reconnect",
        { next_best_actions: ["find_connector", "list_connectors"] },
      );
    }

    // RBAC: `connector:read` on the target connector (parity with
    // call_connector / probe_connector — no `connector:invoke` permission
    // exists, and minting a reauth link is a read-style affordance).
    const auth = await requirePermission(ctx, "connector:read", {
      type: "connector",
      id: connectorId,
    });
    if (!auth.allow) {
      logger.warn({
        module: "conversation_tool",
        action: "request_connector_reauth.failed",
        tenant_id: ctx.tenant_id,
        conversation_id: ctx.conversation_id,
        connector_id: connectorId,
        reason: auth.reason,
        error_code: "permission_denied",
      });
      return structuredError("permission_denied", auth.reason, { permission: "connector:read" });
    }

    const connector = await getConnector(ctx.tenant_id, connectorId, ctx.db);
    if (!connector) {
      return structuredError("connector_not_found", `no connector with id '${connectorId}'`, {
        next_best_actions: ["find_connector", "list_connectors"],
      });
    }

    const { method, reauth_url, instructions } = buildReauthUrl(connector);

    logger.info({
      module: "conversation_tool",
      action: "request_connector_reauth.succeeded",
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      connector_id: connector.id,
      method,
      url_resolved: reauth_url !== null,
    });

    return {
      ok: true,
      data: {
        connector: connector.slug,
        method,
        reauth_url,
        instructions,
        needs_reauth: connector.needs_reauth,
        auth_failed_at: connector.auth_failed_at?.toISOString() ?? null,
      },
    };
  },
};
