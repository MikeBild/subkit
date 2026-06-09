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
// For OAuth2 it returns the provider authorize URL. For non-OAuth
// (basic/bearer/header/query) there is no working click-through form, so it
// instead binds the saved connector into a re-issue draft (sets
// `saved_connector_id`) and asks the LLM to collect the new secret via
// `ask_user_form`; the submission rotates the credential on the SAME connector
// row through the existing auto-persist path. The connector id never changes,
// so workflows that reference it keep working.
//
// RBAC: `connector:write` on the target connector — the non-OAuth path stages
// a credential rotation, so this is a write-class affordance (resolution
// pattern still mirrors `call_connector`: resolveConversationPrincipal + can()).
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
import { hydrateDraftFromSavedConnector } from "../authoring-state/normalize.ts";
import { withConnectorDraft } from "../authoring-state.ts";
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
    "Repair a connector whose credential is dead — flagged `needs_reauth`, or a `call_connector`/`probe_connector` came back `health: auth_failed`. OAuth2 connectors → returns a provider authorize URL to open. Non-OAuth (basic/bearer/header/query) → starts an in-chat credential re-issue: it loads the saved connector into a draft and you then collect the new secret via `ask_user_form`; it rotates in place (same connector id, dependent workflows untouched) — no delete+recreate. Resolves by `connector_id` (uuid) or `slug`.",
  use_case:
    "A saved connector's credential was revoked or rotated upstream and calls now fail with auth_failed. For OAuth2, request_connector_reauth returns the authorize URL to open; for non-OAuth it binds a re-issue draft so the next ask_user_form submission rotates the credential on the existing connector.",
  important_notes: [
    "Pass either `connector_id` (uuid) or `slug`; `connector_id` wins when both are given.",
    "OAuth2 → returns `method: oauth2` + a `reauth_url` (authorize URL) to open. Non-OAuth → returns `method: portal_setup`, `mode: credential_re_issue`, and stages a re-issue draft; follow with `ask_user_form(type: password, sensitive: true)` to collect the new secret and it rotates in place.",
    "Never paste the secret in chat — always collect it through `ask_user_form(type: password, sensitive: true)`.",
    "Requires `connector:write` on the connector (the non-OAuth path stages a credential rotation).",
  ],
  example_input: { slug: "digitalocean" },
  inputSchema: RequestConnectorReauthInput,
  // draft_write: the non-OAuth path calls ctx.setDraft to stage a credential
  // re-issue (same as probe_connector_draft / start_connector_*). The actual
  // credential write happens downstream through the elicitation → auto-persist
  // path, which carries its own gate.
  category: "draft_write",
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

    // RBAC: `connector:write` on the target connector. The non-OAuth path
    // stages a credential re-issue (a write-class affordance), so reading
    // the connector is not enough — a principal who can only read it must
    // not be able to start a credential rotation against it.
    const auth = await requirePermission(ctx, "connector:write", {
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
      return structuredError("permission_denied", auth.reason, { permission: "connector:write" });
    }

    const connector = await getConnector(ctx.tenant_id, connectorId, ctx.db);
    if (!connector) {
      return structuredError("connector_not_found", `no connector with id '${connectorId}'`, {
        next_best_actions: ["find_connector", "list_connectors"],
      });
    }

    const { method, reauth_url, instructions } = buildReauthUrl(connector);

    // Non-OAuth (basic/bearer/header/query) connectors have no working
    // click-through credential form — the legacy `reauth_url` pointed at a
    // POST-only `/credentials` endpoint that renders nothing on GET, so
    // handing it to the user was a dead end (the bug behind the 3.2M-token
    // repair ordeal). Instead, repair IN CHAT: bind the saved connector into
    // a re-issue draft, then have the LLM collect the new secret via a masked
    // `ask_user_form`. The submission flows through the existing auto-persist
    // re-issue path (`saveConnectorAtomic` → `upsertCredential` →
    // `clearConnectorReauth`), rotating the credential on the SAME connector
    // id — no delete+recreate, no orphaned workflows. This is the non-OAuth
    // counterpart of what `authenticate_oauth` does for OAuth.
    if (method === "portal_setup") {
      // A `none`-auth connector has no credential to rotate — staging a
      // re-issue draft and asking for "the new none secret" is nonsensical.
      // (Near-unreachable: a credential-less connector can't fail auth, but
      // guard the tool boundary rather than emit a broken prompt.)
      if (connector.auth_type === "none") {
        return structuredError(
          "no_credential_to_reissue",
          `connector '${connector.slug}' uses auth_type 'none' — there is no credential to re-issue. If it is failing, the base_url or upstream is the issue, not auth.`,
          { next_best_actions: ["probe_connector", "update_connector_draft"] },
        );
      }
      const draftConnector = hydrateDraftFromSavedConnector(connector);
      const nextDraft = withConnectorDraft(
        ctx.getDraft(),
        draftConnector,
        "connector_reauth_started",
      );
      await ctx.setDraft(nextDraft);
      logger.info({
        module: "conversation_tool",
        action: "request_connector_reauth.reissue_draft_bound",
        tenant_id: ctx.tenant_id,
        conversation_id: ctx.conversation_id,
        connector_id: connector.id,
        auth_type: connector.auth_type,
      });
      return {
        ok: true,
        data: {
          connector: connector.slug,
          method,
          mode: "credential_re_issue",
          auth_type: connector.auth_type,
          needs_reauth: connector.needs_reauth,
          auth_failed_at: connector.auth_failed_at?.toISOString() ?? null,
          next_best_actions: ["ask_user_form"],
          next_prompt: `Collect the new ${connector.auth_type} secret for '${connector.slug}' via a masked ask_user_form (type: password, sensitive: true). It rotates in place on the existing connector — the id and every workflow that uses it stay intact.`,
          instructions:
            "Do not paste the secret in chat. Call ask_user_form(type: password, sensitive: true) to collect it; the harness persists it atomically onto the existing connector, clears needs_reauth, and re-probes.",
        },
      };
    }

    // OAuth2: the provider authorize URL is the correct affordance — the
    // dance + callback persists fresh tokens. Unchanged.
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
