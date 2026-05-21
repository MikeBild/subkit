// authenticate_oauth — chat-driven OAuth2 authorization-code dance.
//
// Mirrors the existing MCP `authenticate` product tool
// (`apps/engine/src/mcp/tools/authenticate.ts`) but exposes the same
// capability inside the conversation loop so the agent can drive the
// flow from a connector-creation thread:
//
//   1. save_connector_draft (with template-bound OAuth config OR an
//      explicit credential.mode="oauth2" carrying client_id/secret)
//   2. authenticate_oauth({ connector_id, scopes? })
//   3. The CLI / portal opens `authorization_url` in the user's
//      browser. Callback hits /v1/oauth/callback (single global URL
//      per engine, routed by opaque state) which exchanges the code
//      for tokens and persists them via upsertCredential.
//
// Surface-aware completion (the §6 elicitation rework):
//   - MCP client advertises elicitation (oob) — issue an out-of-band
//     `elicitation/create` with the authorization URL, then block on
//     `waitForOAuthCredential` until the callback lands the credential.
//   - MCP client advertises elicitation (form only — same cap object
//     in SDK 1.29) — issue a form elicitation with an `acknowledged`
//     boolean and the URL in the message, then wait the same way.
//   - No bridge (HTTP/SSE portal) — DB-pause via `ask_user_confirm`
//     carrying the URL; on resume the tool is re-driven and, finding
//     the state row already present, runs `waitForOAuthCredential`.
//
// `withConnectorAuthenticated` is marked ONLY after the credential
// actually lands — the previous optimistic marking (before the operator
// even opened the URL) is the bug this rework fixes.
//
// Follow-up: experimental MCP Tasks (SEP-1686) is the documented path
// for removing the held-open connection during the wait — out of scope
// for this phase.
//
// The credential row is keyed on (tenant_id, connector_id, environment),
// so there is no user-supplied "credential name" — same auto-naming
// pattern as bearer/basic/header/query atomic save.

import { z } from "@hono/zod-openapi";
import { and, desc, eq, gt } from "drizzle-orm";
import { getConnector } from "../../connectors/service.ts";
import { resolveConnectorOAuthConfig } from "../../connectors/template-binding.ts";
import { startAuthorizationCode } from "../../credentials/oauth2/client.ts";
import { buildOAuthRedirectUri } from "../../credentials/oauth2/redirect-uri.ts";
import { waitForOAuthCredential } from "../../credentials/oauth2/wait.ts";
import { connectorOauthStates } from "../../db/schema/index.ts";
import { logger } from "../../logging/logger.ts";
import { ElicitationUnsupportedError } from "../../mcp/elicitation/bridge.ts";
import { withConnectorAuthenticated } from "../authoring-state.ts";
import { pauseForUserInput } from "./ask-user/common.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z
  .object({
    connector_id: z
      .string()
      .uuid()
      .describe(
        "Saved connector to authorize. Falls back to the conversation's target_connector_id when omitted.",
      )
      .optional(),
    scopes: z
      .array(z.string().min(1))
      .optional()
      .describe(
        "OAuth scopes to request. When omitted, the connector template's default scopes apply.",
      ),
    return_url: z
      .string()
      .url()
      .optional()
      .describe("Optional URL to redirect the user back to after a successful authorization."),
  })
  .openapi("AuthenticateOAuthToolInput");

/** Did this connector already get an authorization URL this round? */
async function hasPendingOAuthState(
  ctx: { db: import("../../db/client.ts").Db; tenant_id: string },
  connectorId: string,
): Promise<boolean> {
  const rows = await ctx.db
    .select({ id: connectorOauthStates.id })
    .from(connectorOauthStates)
    .where(
      and(
        eq(connectorOauthStates.tenant_id, ctx.tenant_id),
        eq(connectorOauthStates.connector_id, connectorId),
        gt(connectorOauthStates.expires_at, new Date()),
      ),
    )
    .orderBy(desc(connectorOauthStates.created_at))
    .limit(1);
  return rows.length > 0;
}

export const authenticateOAuthTool: ConversationTool = {
  name: "authenticate_oauth",
  description:
    "Start the OAuth2 authorization-code dance for a saved connector. On MCP clients the authorization prompt is surfaced directly via elicitation and the tool blocks until tokens land; on the portal it pauses for confirmation. Never re-prompt the user for an access token in chat — that path is forbidden. Pair this with `save_connector_draft({ credential: { mode: 'oauth2', ... } })` for connectors with custom client_id/secret.",
  use_case:
    "After `save_connector_draft` for a connector whose template advertises `auth_type: oauth2` (or whose credential mode is `oauth2`), call this tool to obtain the authorization URL and complete authentication.",
  important_notes: [
    "Requires the connector to be saved (has an id in the connectors table). Use `save_connector_draft` first.",
    "The agent NEVER sees access tokens or refresh tokens — they are persisted server-side via the OAuth callback route.",
    "Returns `redirect_uri` alongside `authorization_url` — surface both to the operator. The redirect_uri must be added to the OAuth provider's allowlist BEFORE opening the authorization URL.",
  ],
  inputSchema,
  category: "tenant_write",
  requires_skill: "oauth-flow",
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const connectorId = args.connector_id ?? ctx.connector_id ?? null;
    if (!connectorId) {
      return {
        ok: false,
        data: {
          error: "no_saved_connector",
          message:
            "authenticate_oauth requires a saved connector id. Save the draft first with save_connector_draft.",
        },
      };
    }
    const connector = await getConnector(ctx.tenant_id, connectorId, ctx.db);
    if (!connector) {
      return {
        ok: false,
        data: {
          error: "connector_missing",
          message: `connector ${connectorId} was not found in this tenant.`,
        },
      };
    }
    // `credentials` rows are keyed on connector environment; the
    // connector row carries the canonical environment for this draft.
    const environment: "dev" | "prod" = connector.environment === "prod" ? "prod" : "dev";

    // Resume re-entry — applies to BOTH the bridge and no-bridge paths.
    // If a pending state row already exists, the operator was handed a
    // URL on a prior turn (DB-pause resume, OR a bridge client whose
    // tool call timed out and is being retried). Re-drive straight into
    // the credential wait instead of minting a SECOND authorization URL
    // + a second state row. `waitForOAuthCredential` is idempotent: it
    // returns immediately if the credential already landed.
    if (await hasPendingOAuthState(ctx, connectorId)) {
      const status = await waitForOAuthCredential({
        tenant_id: ctx.tenant_id,
        connector_id: connectorId,
        environment,
        db: ctx.db,
      });
      return finalizeWaitResult(ctx, connector, status);
    }

    const cfg = await resolveConnectorOAuthConfig(ctx.db, ctx.tenant_id, connector);
    if (!cfg) {
      return {
        ok: false,
        data: {
          error: "oauth_not_configured",
          message:
            "this connector is not configured for OAuth2 authentication. Either pick a template with OAuth or save the draft with credential.mode='oauth2'.",
        },
      };
    }
    // Canonical, engine-synthesized redirect_uri. Operators add THIS one
    // URL to their OAuth provider's allowlist; the engine routes the
    // callback to the right connector via the opaque `state` token.
    const redirect_uri = buildOAuthRedirectUri();
    if (!redirect_uri) {
      return {
        ok: false,
        data: {
          error: "engine_public_url_missing",
          message:
            "engine has no resolvable public origin — set server.public_base_url or SUBKIT_PUBLIC_BASE_URL before running an OAuth2 flow.",
        },
      };
    }
    const cfgWithRedirect = { ...cfg, redirect_uri };
    const cfgWithScope =
      args.scopes && args.scopes.length > 0
        ? { ...cfgWithRedirect, scope: args.scopes.join(" ") }
        : cfgWithRedirect;
    const started = await startAuthorizationCode(cfgWithScope);
    const expires = new Date(Date.now() + 10 * 60_000);
    await ctx.db.insert(connectorOauthStates).values({
      tenant_id: ctx.tenant_id,
      connector_id: connectorId,
      state: started.state,
      code_verifier: started.code_verifier,
      redirect_uri,
      expires_at: expires,
    });

    const connectorLabel = connector.display_name ?? connector.slug;
    const message =
      `Authorize ${connectorLabel} in your browser:\n${started.authorization_url}\n\n` +
      `Add this redirect URI to the OAuth provider's allowlist first:\n${redirect_uri}`;

    const bridge = ctx.elicitationBridge;

    // ── MCP oob-capable — out-of-band URL elicitation, then wait ──────
    if (bridge?.capabilities.oob) {
      try {
        await bridge.elicitOob({
          url: started.authorization_url,
          message,
          // The OAuth `state` token is intentionally reused as the
          // elicitation correlation id — it already uniquely identifies
          // this authorization attempt end-to-end (start → callback).
          elicitationId: started.state,
        });
      } catch (err) {
        if (err instanceof ElicitationUnsupportedError) {
          // Capability raced away — fall through to the DB-pause path.
          logger.warn({
            module: "conversation",
            action: "authenticate_oauth.oob_unsupported_fallback",
            msg: "MCP oob elicitation unsupported — falling back to DB-pause",
            tenant_id: ctx.tenant_id,
            connector_id: connectorId,
            error: err.message,
          });
          return dbPauseForOAuth(ctx, started.authorization_url, redirect_uri, message);
        }
        // A transport/timeout failure with the bridge present. Do NOT
        // DB-pause: an external MCP client cannot resume a DB-pause.
        // Return a structured error — the state row is still live, so a
        // retry of `authenticate_oauth` resumes the same flow.
        logger.warn({
          module: "conversation",
          action: "authenticate_oauth.oob_transport_failed",
          msg: "MCP oob elicitation transport failed",
          tenant_id: ctx.tenant_id,
          connector_id: connectorId,
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          ok: false,
          error_code: "oauth_elicitation_transport_failed",
          message:
            "The MCP elicitation for the OAuth authorization URL failed in transit. The authorization state is still valid — call authenticate_oauth again for this connector to retry.",
          data: { authorization_url: started.authorization_url, redirect_uri },
        };
      }
      const status = await waitForOAuthCredential({
        tenant_id: ctx.tenant_id,
        connector_id: connectorId,
        environment,
        db: ctx.db,
      });
      return finalizeWaitResult(ctx, connector, status, {
        authorization_url: started.authorization_url,
        redirect_uri,
        ...(args.return_url ? { return_url: args.return_url } : {}),
      });
    }

    // ── MCP form-capable only — form elicitation with the URL ─────────
    if (bridge?.capabilities.form) {
      try {
        const result = await bridge.elicitForm({
          message,
          requestedSchema: {
            type: "object",
            properties: {
              acknowledged: {
                type: "boolean",
                title: "I have opened the authorization URL",
                description: "Open the URL above, complete the OAuth flow, then confirm.",
              },
            },
            required: ["acknowledged"],
          },
        });
        if (result.action !== "accept") {
          return {
            ok: false,
            error_code: "oauth_authorization_declined",
            message: "The user declined to start the OAuth authorization.",
            data: { authorization_url: started.authorization_url, redirect_uri },
          };
        }
      } catch (err) {
        if (err instanceof ElicitationUnsupportedError) {
          logger.warn({
            module: "conversation",
            action: "authenticate_oauth.form_unsupported_fallback",
            msg: "MCP form elicitation unsupported — falling back to DB-pause",
            tenant_id: ctx.tenant_id,
            connector_id: connectorId,
            error: err.message,
          });
          return dbPauseForOAuth(ctx, started.authorization_url, redirect_uri, message);
        }
        // Transport/timeout failure with the bridge present — do NOT
        // DB-pause (an external MCP client cannot resume one). Return a
        // structured error; the live state row lets a retry resume.
        logger.warn({
          module: "conversation",
          action: "authenticate_oauth.form_transport_failed",
          msg: "MCP form elicitation transport failed",
          tenant_id: ctx.tenant_id,
          connector_id: connectorId,
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          ok: false,
          error_code: "oauth_elicitation_transport_failed",
          message:
            "The MCP elicitation for the OAuth authorization URL failed in transit. The authorization state is still valid — call authenticate_oauth again for this connector to retry.",
          data: { authorization_url: started.authorization_url, redirect_uri },
        };
      }
      const status = await waitForOAuthCredential({
        tenant_id: ctx.tenant_id,
        connector_id: connectorId,
        environment,
        db: ctx.db,
      });
      return finalizeWaitResult(ctx, connector, status, {
        authorization_url: started.authorization_url,
        redirect_uri,
        ...(args.return_url ? { return_url: args.return_url } : {}),
      });
    }

    // ── No bridge — DB-pause via ask_user_confirm ─────────────────────
    return dbPauseForOAuth(ctx, started.authorization_url, redirect_uri, message);
  },
};

/** DB-pause path: surface the authorization URL via `ask_user_confirm`. */
function dbPauseForOAuth(
  ctx: import("./index.ts").ToolContext,
  authorizationUrl: string,
  redirectUri: string,
  message: string,
): Promise<ToolResult> {
  return pauseForUserInput(ctx, {
    tool_name: "ask_user_confirm",
    summary: message,
    input: {
      kind: "external_write",
      question: "Have you completed the authorization in your browser?",
      summary: message,
      // Surfaced verbatim on the `elicit_request` frame so sk-cli can
      // detect the OAuth step and auto-open the browser.
      authorization_url: authorizationUrl,
      redirect_uri: redirectUri,
    },
  });
}

/**
 * Turn a `waitForOAuthCredential` status into a `ToolResult`. On
 * `succeeded` the connector_authenticated checkpoint is marked fresh —
 * and ONLY here, after the credential actually landed.
 */
async function finalizeWaitResult(
  ctx: import("./index.ts").ToolContext,
  connector: { display_name?: string | null; slug: string },
  status: "succeeded" | "failed" | "timeout",
  extra?: Record<string, unknown>,
): Promise<ToolResult> {
  if (status === "succeeded") {
    // `ctx.getDraft()` returns the closure-local draft for THIS
    // `runLoop` invocation. A concurrent `respondElicitation` runs in a
    // separate loop with its own draft closure, so it cannot mutate
    // this one — no re-read is needed before `withConnectorAuthenticated`.
    const draft = ctx.getDraft();
    if (draft.connector) {
      const next = withConnectorAuthenticated(
        draft,
        draft.connector,
        true,
        `OAuth tokens persisted for ${connector.display_name ?? connector.slug}.`,
        "authenticate_oauth",
      );
      await ctx.setDraft(next);
    }
    return {
      ok: true,
      data: {
        status: "authenticated",
        connector: connector.slug,
        ...(extra ?? {}),
      },
    };
  }
  return {
    ok: false,
    error_code: status === "timeout" ? "oauth_timeout" : "oauth_authorization_failed",
    message:
      status === "timeout"
        ? "Still waiting for the OAuth authorization to complete — the authorization is pending, not failed. The authorization URL and state row are still valid: call authenticate_oauth again for this connector to resume waiting for the same flow (it will NOT mint a new URL while the state row is live)."
        : "The OAuth authorization did not complete — no credential was persisted. Re-run authenticate_oauth to try again.",
    data: { status, ...(extra ?? {}) },
  };
}
