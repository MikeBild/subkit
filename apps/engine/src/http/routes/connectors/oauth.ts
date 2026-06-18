// OAuth2 authorization-code flow.
//
//   POST /v1/connectors/{id}/oauth/start    — authenticated. Issues the
//                                             authorization URL + state.
//                                             redirect_uri is synthesized
//                                             server-side; the operator
//                                             never sees a per-connector
//                                             callback path.
//
//   GET  /v1/connectors/{id}/oauth/start    — UNAUTHENTICATED (grant-token
//                                             auth). Consumes a single-use
//                                             skog_… grant token, then
//                                             begins the OAuth dance and
//                                             302-redirects to the provider.
//
//   GET  /v1/oauth/callback                 — UNAUTHENTICATED. The OAuth
//                                             provider redirects here with
//                                             `?code=…&state=…` (success)
//                                             OR `?error=…&state=…` (denial
//                                             / scope rejection). The state
//                                             row carries tenant_id +
//                                             connector_id, so the engine
//                                             routes the credential write
//                                             to the right tenant without
//                                             requiring an API key in the
//                                             user's browser session.
//
// Single global callback URL = operators add one entry to their OAuth
// provider's allowlist (e.g. `https://subkit-api.mikebild.dev/v1/oauth/callback`)
// and reuse it across every OAuth2 connector. The callback is
// connector-agnostic and `state` decodes back to the connector id.

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { and, eq, gt } from "drizzle-orm";
import { ErrorSchema, IdParam } from "../../../api/common-schemas.ts";
import { AuditAction, auditAwait } from "../../../audit/index.ts";
import * as connectorSvc from "../../../connectors/index.ts";
import {
  beginConnectorOAuthDance,
  buildCallbackPageHtml,
  consumeStartGrant,
  escapeHtml,
} from "../../../connectors/index.ts";
import * as credsvc from "../../../credentials/index.ts";
import { buildOAuthRedirectUri, completeAuthorizationCode } from "../../../credentials/index.ts";
import { writeEvent } from "../../../db/events.ts";
import { connectorOauthStates } from "../../../db/schema/index.ts";
import { logger } from "../../../logging/index.ts";
import {
  ConnectorOauthCallbackFailedPayloadSchema,
  type ConnectorOauthCallbackFailedReasons,
  ConnectorOauthCallbackPayloadSchema,
} from "../../../pubsub/index.ts";
import { now } from "../../../utils/clock.ts";
import { BadRequestError, NotFoundError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import type { AppEnv } from "../../openapi.ts";
import { OAuthCallbackQuery, OAuthStartResponse } from "./schemas.ts";

const oauthStartRoute = createRoute({
  method: "post",
  path: "/v1/connectors/{id}/oauth/start",
  tags: ["connectors"],
  summary: "Begin an OAuth2 authorization-code flow",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: OAuthStartResponse } } },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// Single-use grant token query parameter. Min-20 guards against random short
// strings but no semantic validation — the consumeStartGrant service enforces
// the sha256 match and expiry check atomically.
const OAuthStartGrantQuery = z
  .object({ grant: z.string().min(20) })
  .openapi("OAuthStartGrantQuery");

const oauthGrantStartRoute = createRoute({
  method: "get",
  path: "/v1/connectors/{id}/oauth/start",
  tags: ["connectors"],
  summary: "Browser-openable OAuth2 start (single-use grant token)",
  // Unauthenticated: the LLM hands this URL to the operator to open in a
  // browser. Authentication is by way of the single-use opaque `grant`
  // query parameter (skog_… token), which the engine generated and stored
  // in connector_oauth_start_grants as a sha256 hash. Same comment
  // discipline as the unauthenticated /v1/oauth/callback route below.
  request: {
    params: IdParam,
    query: OAuthStartGrantQuery,
  },
  responses: {
    302: { description: "Redirect to provider authorization URL" },
    400: {
      description: "Grant invalid/expired (HTML error page)",
      content: { "text/html": { schema: z.string() } },
    },
  },
});

const oauthCallbackRoute = createRoute({
  method: "get",
  path: "/v1/oauth/callback",
  tags: ["connectors"],
  summary: "Complete an OAuth2 authorization-code flow",
  // Unauthenticated: the OAuth provider redirects the user's browser
  // here with no API key. Authentication is by way of the opaque
  // single-use `state` token, which the engine generated and stored
  // in connector_oauth_states with the (tenant_id, connector_id) pair.
  request: { query: OAuthCallbackQuery },
  responses: {
    200: { description: "OK (HTML)", content: { "text/html": { schema: z.string() } } },
    400: { description: "Bad request (HTML)", content: { "text/html": { schema: z.string() } } },
  },
});

export function registerOAuthRoutes(app: OpenAPIHono<AppEnv>): void {
  // ── POST /v1/connectors/{id}/oauth/start ─────────────────────────────────
  // Authenticated bearer-token path. Thin wrapper around beginConnectorOAuthDance.
  app.openapi(oauthStartRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");

    const redirect_uri = buildOAuthRedirectUri({ req: c.req.raw });
    if (!redirect_uri) {
      throw new BadRequestError(
        "engine has no resolvable public origin — set server.public_base_url or SUBKIT_PUBLIC_BASE_URL",
      );
    }

    const result = await beginConnectorOAuthDance({
      db,
      tenant_id: principal.tenant_id,
      connector_id: id,
      actor_id: principal.id,
      redirect_uri,
    });

    if (result.kind === "done") {
      // Return a synthetic authorization_url so callers that check for the
      // field don't break. An empty state signals "no browser flow needed".
      return c.json({ authorization_url: "", state: "" }, 200);
    }
    return c.json({ authorization_url: result.authorization_url, state: result.state }, 200);
  });

  // ── GET /v1/connectors/{id}/oauth/start?grant=skog_… ─────────────────────
  // Unauthenticated browser-grant path. Atomically consumes the single-use
  // grant token, then begins the dance and 302-redirects to the provider.
  app.openapi(oauthGrantStartRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const { grant } = c.req.valid("query");

    // Atomic claim: wrong connector_id does NOT burn the grant.
    const claimed = await consumeStartGrant(db, { token: grant, connector_id: id });
    if (!claimed) {
      // Do not echo the grant token in HTML or logs.
      logger.warn({
        module: "oauth",
        action: "oauth.grant_start.invalid",
        msg: "start grant not found, expired, or wrong connector — browser opened an invalid link",
        connector_id: id,
      });
      return renderHtmlResponse(c, {
        kind: "error",
        title: "Sign-in link expired",
        message:
          "This sign-in link was already used or has expired — ask the assistant for a fresh link.",
      });
    }

    // Tenant is derived ONLY from the claimed row — never from the request.
    const { tenant_id, connector_id, created_by_actor_id } = claimed;

    // The consumer is an unauthenticated browser — the grant token IS the
    // auth. Attribution to the minting principal lives in metadata (and on
    // the paired GRANT_ISSUED row); recording it as the acting principal
    // here would claim a user performed a request they never made.
    await auditAwait(
      {
        tenant_id,
        actor_type: "system",
        actor_id: null,
        action: AuditAction.CONNECTOR_OAUTH_GRANT_CONSUMED,
        resource_type: "connector",
        resource_id: connector_id,
        result: "success",
        metadata: { connector_id, created_by_actor_id },
      },
      db,
    );

    const redirect_uri = buildOAuthRedirectUri({ req: c.req.raw });
    if (!redirect_uri) {
      return renderHtmlResponse(c, {
        kind: "error",
        title: "Engine misconfigured",
        message:
          "The engine has no resolvable public origin. Ask your administrator to set server.public_base_url.",
      });
    }

    try {
      const result = await beginConnectorOAuthDance({
        db,
        tenant_id,
        connector_id,
        actor_id: null,
        redirect_uri,
      });

      if (result.kind === "done") {
        return renderHtmlResponse(c, {
          kind: "success",
          title: "Authorized",
          message:
            "Connector credentials refreshed. You can close this tab and return to the assistant.",
        });
      }

      // 302 to provider authorization URL.
      return c.redirect(result.authorization_url, 302);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({
        module: "oauth",
        action: "oauth.grant_start.dance_failed",
        msg: "OAuth dance failed after grant consumed",
        tenant_id,
        connector_id,
        error: message,
      });
      return renderHtmlResponse(c, {
        kind: "error",
        title: "Authorization failed",
        message:
          "Something went wrong starting the authorization. This link has been used up — ask the assistant for a fresh link.",
      });
    }
  });

  // ── GET /v1/oauth/callback ────────────────────────────────────────────────
  app.openapi(oauthCallbackRoute, async (c) => {
    const db = c.get("db");
    const q = c.req.valid("query");
    // Atomic single-use claim: DELETE … RETURNING the state row. If
    // two callers race on the same `state`, only one wins; the second
    // sees no row and renders the not-found page. Removes the read /
    // exchange / delete TOCTOU window where two callbacks could both
    // exchange the (now-redeemed) code and write a credential.
    // tenant-filter:exempt — this route is unauthenticated (OAuth
    // provider redirects the user's browser back with no API key).
    // Authentication is by way of the opaque single-use `state` token,
    // which has a unique index on connectorOauthStates.state. The
    // resolved tenant_id comes from the matched row and is used for
    // every subsequent write.
    // pattern: state-token-auth-callback — see also the external MCP
    // server OAuth callback (http/routes/mcp-servers-oauth.ts), which
    // applies the same claim-then-derive-tenant discipline.
    const claimed = await db
      .delete(connectorOauthStates)
      .where(
        and(
          eq(connectorOauthStates.state, q.state),
          gt(connectorOauthStates.expires_at, new Date(now())),
        ),
      )
      .returning();
    const stateRow = claimed[0];
    if (!stateRow) {
      logger.warn({
        module: "oauth",
        action: "oauth.callback.state_not_found",
        msg: "no fresh state row matched the callback",
        state_prefix: q.state.slice(0, 8),
        had_code: Boolean(q.code),
        had_error: Boolean(q.error),
      });
      // No `callback_failed` publish here: with no `stateRow` there is
      // no tenant_id/connector_id to scope the event to. A waiter is
      // keyed to a real state token, so a bogus/expired callback simply
      // lets that waiter time out — which is the correct outcome.
      return renderHtmlResponse(c, {
        kind: "error",
        title: "OAuth state not found",
        message:
          "The authorization state has expired or was already redeemed. Close this tab and run authenticate_oauth again to start a fresh OAuth flow.",
      });
    }

    // Provider error path — user denied access, scope rejected, etc.
    // The state row has been claimed (deleted) above; that's fine —
    // the operator must call authenticate_oauth again anyway.
    if (q.error) {
      logger.warn({
        module: "oauth",
        action: "oauth.callback.provider_error",
        msg: "oauth provider returned an error",
        tenant_id: stateRow.tenant_id,
        connector_id: stateRow.connector_id,
        state_prefix: stateRow.state.slice(0, 8),
        provider_error: q.error,
        provider_error_description: q.error_description ?? null,
      });
      // `reason` is a sanitized token, not `q.error` verbatim: provider
      // error strings can embed request fragments (state tokens,
      // redirect URIs) and this event is broadcast over pub/sub. The
      // verbose `q.error` stays in the `logger.warn` above only.
      await publishCallbackFailed(db, {
        tenant_id: stateRow.tenant_id,
        connector_id: stateRow.connector_id,
        reason: "provider_error",
      });
      return renderHtmlResponse(c, {
        kind: "error",
        title: "OAuth provider returned an error",
        message:
          q.error_description ??
          `The OAuth provider rejected the authorization request: ${q.error}. Close this tab and try again.`,
      });
    }

    if (!q.code) {
      logger.warn({
        module: "oauth",
        action: "oauth.callback.missing_code",
        msg: "callback had no code parameter and no error",
        tenant_id: stateRow.tenant_id,
        connector_id: stateRow.connector_id,
        state_prefix: stateRow.state.slice(0, 8),
      });
      await publishCallbackFailed(db, {
        tenant_id: stateRow.tenant_id,
        connector_id: stateRow.connector_id,
        reason: "missing_code",
      });
      return renderHtmlResponse(c, {
        kind: "error",
        title: "OAuth callback missing code",
        message:
          "The OAuth provider redirected back without an authorization code or error. Close this tab and run authenticate_oauth again.",
      });
    }

    try {
      const connector = await connectorSvc.getConnector(
        stateRow.tenant_id,
        stateRow.connector_id,
        db,
      );
      if (!connector) throw new NotFoundError("connector");
      const cfg = await connectorSvc.resolveConnectorOAuthConfig(db, stateRow.tenant_id, connector);
      if (!cfg) throw new BadRequestError("connector is missing oauth2 config");
      const cfgWithRedirect = { ...cfg, redirect_uri: stateRow.redirect_uri };
      const current = new URL(stateRow.redirect_uri);
      current.searchParams.set("code", q.code);
      current.searchParams.set("state", q.state);
      const bundle = await completeAuthorizationCode({
        cfg: cfgWithRedirect,
        current_url: current,
        code_verifier: stateRow.code_verifier,
        state: stateRow.state,
      });
      // G6 (runtime-logs review plan): compute the requested-vs-granted
      // scope diff so the credential row carries an authoritative
      // record of what the IdP actually approved.
      const requestedScopes = stateRow.requested_scopes
        ? stateRow.requested_scopes
            .split(/\s+/)
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
        : [];
      const grantedScopes = bundle.scope
        ? bundle.scope
            .split(/\s+/)
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
        : [];
      const missingScopes = requestedScopes.filter((s) => !grantedScopes.includes(s));
      const isPartialGrant = requestedScopes.length > 0 && missingScopes.length > 0;
      await credsvc.upsertCredential(
        {
          tenant_id: stateRow.tenant_id,
          connector_id: stateRow.connector_id,
          environment: connector.environment,
          mode: "oauth2",
          value: {
            mode: "oauth2",
            access_token: bundle.access_token,
            token_type: bundle.token_type,
            ...(bundle.scope ? { scope: bundle.scope } : {}),
          },
          oauth2_refresh_token: bundle.refresh_token ?? null,
          oauth2_expires_at: bundle.expires_at,
          // G6: stash the granted scope string on the credential row
          // so probe_connector / test_connector can surface a
          // `partial_grant` warning without re-fetching the bundle.
          oauth2_granted_scopes: bundle.scope ?? null,
          // Anonymous browser hit — no operator principal. The
          // state-row tenant scope is the auth proof; the credential
          // service writes `actor_type: "system"` for null actor_id.
          actor_id: null,
          // Provenance tag so operators can distinguish callback-
          // triggered credential writes from tool-issued ones or
          // refresh-worker rotations in the audit + metadata trail.
          source: "oauth_callback",
        },
        db,
      );
      logger.info({
        module: "oauth",
        action: "oauth.callback.success",
        msg: "credential persisted from oauth callback",
        tenant_id: stateRow.tenant_id,
        connector_id: stateRow.connector_id,
        state_prefix: stateRow.state.slice(0, 8),
        has_refresh_token: bundle.refresh_token != null,
        requested_scopes_count: requestedScopes.length,
        granted_scopes_count: grantedScopes.length,
        partial_grant: isPartialGrant,
        ...(isPartialGrant ? { missing_scopes: missingScopes } : {}),
      });
      if (isPartialGrant) {
        logger.warn({
          module: "oauth",
          action: "oauth.callback.partial_grant",
          msg: "user granted a strict subset of the requested OAuth scopes — calls against missing scopes will 401",
          tenant_id: stateRow.tenant_id,
          connector_id: stateRow.connector_id,
          missing_scopes: missingScopes,
          requested_scopes: requestedScopes,
          granted_scopes: grantedScopes,
        });
      }
      // Publish a `connector.oauth.callback_succeeded` event so any
      // active sk-cli conversation tailing `/v1/events/stream?channel=
      // connector.oauth&type=connector.oauth.callback_succeeded` can
      // auto-resume without the operator typing "done". Best-effort.
      try {
        const payload = ConnectorOauthCallbackPayloadSchema.parse({
          connector_id: stateRow.connector_id,
          connector_slug: connector.slug,
          has_refresh_token: bundle.refresh_token != null,
          source: "oauth_callback",
        });
        await writeEvent(db, {
          tenant_id: stateRow.tenant_id,
          channel: "connector.oauth",
          type: "connector.oauth.callback_succeeded",
          payload,
        });
      } catch (publishErr) {
        logger.warn({
          module: "oauth",
          action: "oauth.callback.event_publish_failed",
          msg: "credential persisted but pubsub event could not be written; conversation will not auto-resume via SSE this round",
          tenant_id: stateRow.tenant_id,
          connector_id: stateRow.connector_id,
          error: publishErr instanceof Error ? publishErr.message : String(publishErr),
        });
      }
      return renderHtmlResponse(c, {
        kind: "success",
        title: "Authentication complete",
        message: `Connector "${connector.display_name ?? connector.slug}" is now authorized. You can close this tab and return to the CLI.`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({
        module: "oauth",
        action: "oauth.callback.exchange_failed",
        msg: "token exchange or credential write failed",
        tenant_id: stateRow.tenant_id,
        connector_id: stateRow.connector_id,
        state_prefix: stateRow.state.slice(0, 8),
        error: message,
      });
      // `reason` is a sanitized token, not the exchange `message`
      // verbatim: a token-exchange exception can embed request fragments
      // (state tokens, redirect URIs) and this event is broadcast over
      // pub/sub. The verbose `message` stays in the `logger.warn` above.
      await publishCallbackFailed(db, {
        tenant_id: stateRow.tenant_id,
        connector_id: stateRow.connector_id,
        reason: "token_exchange_failed",
      });
      return renderHtmlResponse(c, {
        kind: "error",
        title: "Token exchange failed",
        message: `${message}\n\nClose this tab and run authenticate_oauth again to retry.`,
      });
    }
  });
}

/**
 * Record an OAuth-callback failure for a claimed state row, then publish
 * the `connector.oauth.callback_failed` event.
 *
 * The callback DELETEs the `connector_oauth_states` row at the start of
 * the request — a state change. AGENTS.md requires every state change to
 * write an `audit_log` entry, so the durable, append-only audit row is
 * written FIRST (awaited — it must not be lost), then the best-effort
 * pubsub event is published for live waiters.
 *
 * The state-not-found branch does NOT call this: with no claimed row
 * there is no tenant_id/connector_id to scope the audit row to.
 */
async function publishCallbackFailed(
  db: import("../../../db/client.ts").Db,
  p: {
    tenant_id: string;
    connector_id: string;
    reason: (typeof ConnectorOauthCallbackFailedReasons)[number];
  },
): Promise<void> {
  // Durable compliance record for the state change (the claimed state
  // row was deleted). The sanitized `reason` token — never the verbose
  // provider/exchange error — carries the failure classification.
  await auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: "system",
      actor_id: null,
      action: AuditAction.CONNECTOR_OAUTH_CALLBACK_FAILED,
      resource_type: "connector",
      resource_id: p.connector_id,
      result: "error",
      reason: p.reason,
      metadata: { connector_id: p.connector_id, reason: p.reason },
    },
    db,
  );
  try {
    const connector = await connectorSvc.getConnector(p.tenant_id, p.connector_id, db);
    if (!connector) throw new NotFoundError("connector");
    const payload = ConnectorOauthCallbackFailedPayloadSchema.parse({
      connector_id: p.connector_id,
      connector_slug: connector.slug,
      reason: p.reason,
    });
    await writeEvent(db, {
      tenant_id: p.tenant_id,
      channel: "connector.oauth",
      type: "connector.oauth.callback_failed",
      payload,
    });
  } catch (publishErr) {
    logger.warn({
      module: "oauth",
      action: "oauth.callback.failed_event_publish_failed",
      msg: "oauth callback failed but the callback_failed pubsub event could not be written; a waiter will time out instead of failing fast",
      tenant_id: p.tenant_id,
      connector_id: p.connector_id,
      error: publishErr instanceof Error ? publishErr.message : String(publishErr),
    });
  }
}

// Render a browser-facing OAuth page using the shared html builder.
function renderHtmlResponse(
  c: Parameters<Parameters<OpenAPIHono<AppEnv>["openapi"]>[1]>[0],
  page: { kind: "success" | "error"; title: string; message: string },
): Response {
  const { html, status } = buildCallbackPageHtml(page);
  return c.body(html, status, { "content-type": "text/html; charset=utf-8" });
}

// Re-exported so external tests can verify the escaping behaviour without
// importing the full route module.
export { escapeHtml };
