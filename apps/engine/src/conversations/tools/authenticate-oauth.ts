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
// Surface-aware completion:
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
// Follow-up: MCP Tasks (SEP-1686) could remove the held-open connection.
//
// The credential row is keyed on (tenant_id, connector_id, environment),
// so there is no user-supplied "credential name" — same auto-naming
// pattern as bearer/basic/header/query atomic save.

import { z } from "@hono/zod-openapi";
import { OAUTH_AUTHORIZATION_URL_FIELD } from "@shared/elicitation-constants.ts";
import { and, desc, eq, gt } from "drizzle-orm";
import { getConnector } from "../../connectors/service.ts";
import { resolveConnectorOAuthConfig } from "../../connectors/template-binding.ts";
import { startAuthorizationCode } from "../../credentials/oauth2/client.ts";
import { buildOAuthRedirectUri } from "../../credentials/oauth2/redirect-uri.ts";
import {
  OAUTH_WAIT_CEILING_MS,
  OAUTH_WAIT_MIN_FLOOR_MS,
  type OAuthWaitStatus,
  waitForOAuthCredential,
} from "../../credentials/oauth2/wait.ts";
import { connectorOauthStates } from "../../db/schema/index.ts";
import { logger } from "../../logging/logger.ts";
import { ElicitationUnsupportedError } from "../../mcp/elicitation/bridge.ts";
import { withConnectorAuthenticated } from "../authoring-state.ts";
import { createNativeElicitation, resolveElicitationAndReactivate } from "../elicitations.ts";
import { pauseForUserInput } from "./ask-user/common.ts";
import {
  OAUTH_AUTHORIZATION_DECLINED,
  OAUTH_AUTHORIZATION_FAILED,
  OAUTH_ELICITATION_TRANSPORT_FAILED,
  OAUTH_TIMEOUT,
  OAUTH_TOO_MANY_CONCURRENT,
} from "./error-codes.ts";
import type { ConversationTool, ToolContext, ToolResult } from "./index.ts";

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

/**
 * Open the governance elicitation row for an MCP-native OAuth prompt.
 *
 * The DB-pause path writes an `APPROVAL_REQUESTED` audit row via
 * `pauseForUserInput → createElicitation`. The MCP-native oob/form
 * branches issue `elicitation/create` straight through the bridge, so
 * without this they would skip that audit trail entirely. Insert a
 * `protocol_native` carrier row BEFORE the bridge call so the
 * APPROVAL_REQUESTED → APPROVAL_APPROVED/REJECTED lifecycle is recorded
 * for the OAuth authorization the same way the portal path records it.
 *
 * `ask_user_confirm` is the carrier tool name — the operator is
 * confirming a governed external authorization, the same intent the
 * DB-pause path expresses via `ask_user_confirm`.
 */
function openOAuthApprovalElicitation(
  ctx: ToolContext,
  p: { connectorLabel: string; authorizationUrl: string; message: string },
): Promise<import("../elicitations.ts").ElicitationRecord> {
  return createNativeElicitation(
    {
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      tool_call_id: ctx.tool_call_id ?? null,
      ...(ctx.assistant_message_id ? { parent_message_id: ctx.assistant_message_id } : {}),
      tool_name: "ask_user_confirm",
      summary: `Authorize OAuth access for ${p.connectorLabel}.`,
      input: {
        kind: "external_write",
        question: "Have you completed the authorization in your browser?",
        summary: p.message,
        [OAUTH_AUTHORIZATION_URL_FIELD]: p.authorizationUrl,
      },
      actor_id: ctx.actor_id,
    },
    ctx.db,
  );
}

/**
 * Close the governance elicitation row once `waitForOAuthCredential`
 * settles. `succeeded` → `resolved` (APPROVAL_APPROVED); every other
 * status → `cancelled` (APPROVAL_REJECTED) with the matching structured
 * error code as the reason. Idempotent against a lost race: a concurrent
 * resolver makes the conditional update miss, which `resolveElicitation`
 * reports as `already_resolved` — harmless here, the audit row already
 * landed.
 */
async function resolveOAuthApprovalElicitation(
  ctx: ToolContext,
  elicitationId: string,
  status: OAuthWaitStatus,
): Promise<void> {
  await resolveElicitationAndReactivate(
    {
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      id: elicitationId,
      output: { status },
      decided_by: ctx.actor_id,
      status: status === "succeeded" ? "resolved" : "cancelled",
      ...(status === "succeeded" ? {} : { reason: oauthWaitErrorCode(status) }),
      // This row was delivered through the bridge (oob/form) and the
      // round-trip completed — the operator answered. The subsequent
      // wait outcome is independent of the elicitation transport.
      transport: "succeeded",
    },
    ctx.db,
  );
}

/**
 * Map a non-`succeeded` `waitForOAuthCredential` status to its canonical
 * structured `error_code`. Kept in one place so `finalizeWaitResult` and
 * `resolveOAuthApprovalElicitation` cannot drift.
 */
function oauthWaitErrorCode(status: "failed" | "timeout" | "rejected_concurrency"): string {
  switch (status) {
    case "timeout":
      return OAUTH_TIMEOUT;
    case "rejected_concurrency":
      return OAUTH_TOO_MANY_CONCURRENT;
    case "failed":
      return OAUTH_AUTHORIZATION_FAILED;
  }
}

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

/**
 * Remaining `waitForOAuthCredential` budget after a bridge elicitation
 * round-trip already consumed part of the client's shared tool-call
 * timeout. `bridgeStartedAt` is captured immediately before the
 * `elicitOob` / `elicitForm` call; the elapsed bridge cost is subtracted
 * from `OAUTH_WAIT_CEILING_MS` and clamped to `OAUTH_WAIT_MIN_FLOOR_MS`
 * so the wait always gets at least a few DB-poll ticks.
 */
function remainingWaitBudgetMs(bridgeStartedAt: number): number {
  const elapsed = Date.now() - bridgeStartedAt;
  return Math.max(OAUTH_WAIT_MIN_FLOOR_MS, OAUTH_WAIT_CEILING_MS - elapsed);
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
      // Open the governance elicitation row BEFORE the bridge call so
      // the APPROVAL_REQUESTED audit row is written for this OAuth
      // authorization — matching the DB-pause path's audit trail.
      const approval = await openOAuthApprovalElicitation(ctx, {
        connectorLabel,
        authorizationUrl: started.authorization_url,
        message,
      });
      // Start the shared-budget clock before the bridge round-trip so its
      // cost is subtracted from the `waitForOAuthCredential` timeout.
      const bridgeStartedAt = Date.now();
      try {
        // Deliberate: an oob transport failure mid-call returns a
        // structured error and the agent re-calls authenticate_oauth —
        // there is NO automatic fallback to a form-mode elicitation
        // retry. The behaviour is predictable and the live state row
        // makes the retry resume the same flow.
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
          // `dbPauseForOAuth → createElicitation` supersedes the row
          // opened above, so the audit trail stays consistent.
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
        await resolveElicitationAndReactivate(
          {
            tenant_id: ctx.tenant_id,
            conversation_id: ctx.conversation_id,
            id: approval.id,
            output: null,
            decided_by: ctx.actor_id,
            status: "cancelled",
            reason: OAUTH_ELICITATION_TRANSPORT_FAILED,
            transport: "failed",
          },
          ctx.db,
        );
        return {
          ok: false,
          error_code: OAUTH_ELICITATION_TRANSPORT_FAILED,
          message:
            "The MCP elicitation for the OAuth authorization URL failed in transit. The authorization state is still valid — call authenticate_oauth again for this connector to retry.",
          data: { authorization_url: started.authorization_url, redirect_uri },
        };
      }
      const status = await waitForOAuthCredential({
        tenant_id: ctx.tenant_id,
        connector_id: connectorId,
        environment,
        timeout_ms: remainingWaitBudgetMs(bridgeStartedAt),
        db: ctx.db,
      });
      await resolveOAuthApprovalElicitation(ctx, approval.id, status);
      return finalizeWaitResult(ctx, connector, status, {
        authorization_url: started.authorization_url,
        redirect_uri,
        ...(args.return_url ? { return_url: args.return_url } : {}),
      });
    }

    // ── MCP form-capable only — form elicitation with the URL ─────────
    if (bridge?.capabilities.form) {
      // Governance elicitation row — same audit-trail rationale as the
      // oob branch above.
      const approval = await openOAuthApprovalElicitation(ctx, {
        connectorLabel,
        authorizationUrl: started.authorization_url,
        message,
      });
      // Start the shared-budget clock before the bridge round-trip so its
      // cost is subtracted from the `waitForOAuthCredential` timeout.
      const bridgeStartedAt = Date.now();
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
        // An explicit non-accept action is a decline. An `accept` whose
        // `acknowledged` boolean is not `true` is ALSO a decline: the
        // operator dismissed the form without confirming they completed
        // the authorization, so proceeding into `waitForOAuthCredential`
        // and resolving the audit row as APPROVAL_APPROVED would be
        // semantically wrong. Both collapse to the same decline path.
        if (result.action !== "accept" || result.content?.acknowledged !== true) {
          await resolveElicitationAndReactivate(
            {
              tenant_id: ctx.tenant_id,
              conversation_id: ctx.conversation_id,
              id: approval.id,
              output: null,
              decided_by: ctx.actor_id,
              status: "cancelled",
              reason: OAUTH_AUTHORIZATION_DECLINED,
              // The form round-trip completed — the operator answered
              // (declined / did not acknowledge). Transport succeeded.
              transport: "succeeded",
            },
            ctx.db,
          );
          return {
            ok: false,
            error_code: OAUTH_AUTHORIZATION_DECLINED,
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
        await resolveElicitationAndReactivate(
          {
            tenant_id: ctx.tenant_id,
            conversation_id: ctx.conversation_id,
            id: approval.id,
            output: null,
            decided_by: ctx.actor_id,
            status: "cancelled",
            reason: OAUTH_ELICITATION_TRANSPORT_FAILED,
            transport: "failed",
          },
          ctx.db,
        );
        return {
          ok: false,
          error_code: OAUTH_ELICITATION_TRANSPORT_FAILED,
          message:
            "The MCP elicitation for the OAuth authorization URL failed in transit. The authorization state is still valid — call authenticate_oauth again for this connector to retry.",
          data: { authorization_url: started.authorization_url, redirect_uri },
        };
      }
      const status = await waitForOAuthCredential({
        tenant_id: ctx.tenant_id,
        connector_id: connectorId,
        environment,
        timeout_ms: remainingWaitBudgetMs(bridgeStartedAt),
        db: ctx.db,
      });
      await resolveOAuthApprovalElicitation(ctx, approval.id, status);
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
      // `external_write` is deliberate: it forces this OAuth pause to be
      // non-auto-approvable. A dedicated `external_authorization` kind was
      // considered and rejected — it would risk an approval-semantics
      // regression for no behavioural gain.
      kind: "external_write",
      question: "Have you completed the authorization in your browser?",
      summary: message,
      // Surfaced verbatim on the `elicit_request` frame so sk-cli can
      // detect the OAuth step and auto-open the browser. The field name
      // is the shared `OAUTH_AUTHORIZATION_URL_FIELD` contract.
      [OAUTH_AUTHORIZATION_URL_FIELD]: authorizationUrl,
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
  status: OAuthWaitStatus,
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
    error_code: oauthWaitErrorCode(status),
    message: oauthWaitFailureMessage(status),
    data: { status, ...(extra ?? {}) },
  };
}

/** Human-readable message for a non-`succeeded` wait status. */
function oauthWaitFailureMessage(status: "failed" | "timeout" | "rejected_concurrency"): string {
  switch (status) {
    case "timeout":
      return "Still waiting for the OAuth authorization to complete — the authorization is pending, not failed. The authorization URL and state row are still valid: call authenticate_oauth again for this connector to resume waiting for the same flow (it will NOT mint a new URL while the state row is live).";
    case "rejected_concurrency":
      return "This tenant already has the maximum number of OAuth authorizations waiting at once. The authorization state row is still valid — wait a short moment, then call authenticate_oauth again for this connector to resume the same flow.";
    case "failed":
      return "The OAuth authorization did not complete — no credential was persisted. Re-run authenticate_oauth to try again.";
  }
}
