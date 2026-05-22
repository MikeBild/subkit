// OAuth2 authorization-code flow.
//
//   POST /v1/connectors/{id}/oauth/start    — authenticated. Issues the
//                                             authorization URL + state.
//                                             redirect_uri is synthesized
//                                             server-side; the operator
//                                             never sees a per-connector
//                                             callback path.
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
// and reuse it across every OAuth2 connector. Mirrors the reference
// impl pattern where the callback is connector-agnostic and `state`
// decodes back to the system_id.

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { and, eq, gt } from "drizzle-orm";
import { ErrorSchema, IdParam } from "../../../api/common-schemas.ts";
import {
  AuditAction,
  auditAwait,
  recordOAuthClientRegistered,
  recordOAuthClientRegistrationFailed,
} from "../../../audit/index.ts";
import * as connectorSvc from "../../../connectors/index.ts";
import { getConnectorTemplateSnapshot } from "../../../connectors/index.ts";
import * as credsvc from "../../../credentials/index.ts";
import {
  buildOAuthRedirectUri,
  completeAuthorizationCode,
  DynamicRegistrationError,
  dynamicallyRegisterClient,
  startAuthorizationCode,
} from "../../../credentials/index.ts";
import { writeEvent } from "../../../db/events.ts";
import { connectorOauthStates, connectors } from "../../../db/schema/index.ts";
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
import { connectorOauthCfg, OAuthCallbackQuery, OAuthStartResponse } from "./schemas.ts";

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
  app.openapi(oauthStartRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    let connector = await connectorSvc.getConnector(principal.tenant_id, id, db);
    if (!connector) throw new NotFoundError("connector");

    const redirect_uri = buildOAuthRedirectUri({ req: c.req.raw });
    if (!redirect_uri) {
      throw new BadRequestError(
        "engine has no resolvable public origin — set server.public_base_url or SUBKIT_PUBLIC_BASE_URL",
      );
    }

    const snapshot = getConnectorTemplateSnapshot(connector);
    const templateOauth = snapshot?.oauth ?? null;
    const oauthBlock = (connector.config?.oauth ?? {}) as Record<string, unknown>;
    const needsDynamicReg =
      templateOauth?.dynamic_registration === true &&
      (oauthBlock.client_id === null || oauthBlock.client_id === undefined);

    if (needsDynamicReg) {
      const connectorForReg = connector;
      const issuerUrl =
        (oauthBlock.issuer_url as string | undefined) ?? templateOauth?.issuer_url ?? "";
      const issuerHost = issuerUrl ? new URL(issuerUrl).host : "";
      let registrationEndpointHost: string | null = null;
      try {
        const result = await dynamicallyRegisterClient({
          issuerUrl,
          clientMetadata: { redirect_uris: [redirect_uri] },
          allowInsecureRequests: new URL(issuerUrl).protocol === "http:",
        });
        const resolvedRegistrationHost = new URL(result.registrationEndpoint).host;
        registrationEndpointHost = resolvedRegistrationHost;

        // Single transaction: credential insert + connector config update +
        // audit row must all land or all roll back. A crash between the
        // credential write and the connector patch would otherwise leave a
        // confidential client_secret encrypted-at-rest with no client_id
        // in config to reference it; between the patch and the audit row,
        // an unaudited secret persisted under an operator's tenant.
        const updatedOauthBlock = { ...oauthBlock, client_id: result.clientId };
        const updatedConfig = { ...connectorForReg.config, oauth: updatedOauthBlock };
        await db.transaction(async (tx) => {
          await credsvc.upsertCredential(
            {
              tenant_id: principal.tenant_id,
              connector_id: id,
              environment: connectorForReg.environment,
              mode: "oauth2_client",
              value: {
                mode: "oauth2_client",
                client_id: result.clientId,
                ...(result.clientSecret ? { client_secret: result.clientSecret } : {}),
              },
              actor_id: principal.id,
              source: "http_route",
            },
            tx,
          );
          await tx
            .update(connectors)
            .set({ config: updatedConfig, updated_at: new Date() })
            .where(and(eq(connectors.tenant_id, principal.tenant_id), eq(connectors.id, id)));
          await recordOAuthClientRegistered({
            tenant_id: principal.tenant_id,
            actor_id: principal.id,
            connector_id: id,
            issuer_url_host: issuerHost,
            registration_endpoint_host: resolvedRegistrationHost,
            executor: tx,
          });
        });
        connector = { ...connectorForReg, config: updatedConfig };

        logger.info({
          module: "oauth",
          action: "oauth.dynamic_registration.completed",
          msg: "dynamic client registered and credential persisted",
          tenant_id: principal.tenant_id,
          connector_id: id,
          issuer_url_host: issuerHost,
          registration_endpoint_host: registrationEndpointHost,
        });
      } catch (err) {
        const errorCode = err instanceof DynamicRegistrationError ? err.error_code : "unknown";
        await recordOAuthClientRegistrationFailed({
          tenant_id: principal.tenant_id,
          actor_id: principal.id,
          connector_id: id,
          issuer_url_host: issuerHost,
          registration_endpoint_host: registrationEndpointHost,
          error_code: errorCode,
          executor: db,
        });
        throw err;
      }
    }

    const cfg = await connectorOauthCfg(db, principal.tenant_id, connector);
    const cfgWithRedirect = { ...cfg, redirect_uri };
    const started = await startAuthorizationCode(cfgWithRedirect);
    await db.insert(connectorOauthStates).values({
      tenant_id: principal.tenant_id,
      connector_id: id,
      state: started.state,
      code_verifier: started.code_verifier,
      redirect_uri,
      expires_at: new Date(Date.now() + 10 * 60_000),
    });
    logger.info({
      module: "oauth",
      action: "oauth.start",
      msg: "issued authorization URL",
      tenant_id: principal.tenant_id,
      connector_id: id,
      state_prefix: started.state.slice(0, 8),
      redirect_uri,
    });
    return c.json({ authorization_url: started.authorization_url, state: started.state }, 200);
  });

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
      return renderCallbackPage(c, {
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
      return renderCallbackPage(c, {
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
      return renderCallbackPage(c, {
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
      const cfg = await connectorOauthCfg(db, stateRow.tenant_id, connector);
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
      });
      // Publish a `connector.oauth.callback_succeeded` event so any
      // active sk-cli conversation tailing `/v1/events/stream?channel=
      // connector.oauth&type=connector.oauth.callback_succeeded` can
      // auto-resume without the operator typing "done". Tenant-scoped
      // by writeEvent's `tenant_id` parameter, which the events stream
      // filters on at read time — no cross-tenant leak. Best-effort:
      // the credential is already persisted; a publish failure must
      // not derail the operator's success path.
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
      return renderCallbackPage(c, {
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
      return renderCallbackPage(c, {
        kind: "error",
        title: "Token exchange failed",
        message: `${message}\n\nClose this tab and run authenticate_oauth again to retry.`,
      });
    }
  });
}

interface CallbackPage {
  kind: "success" | "error";
  title: string;
  message: string;
}

/**
 * Record an OAuth-callback failure for a claimed state row, then publish
 * the `connector.oauth.callback_failed` event.
 *
 * The callback DELETEs the `connector_oauth_states` row at the start of
 * the request — a state change. AGENTS.md requires every state change to
 * write an `audit_log` entry, so the durable, append-only audit row is
 * written FIRST (awaited — it must not be lost), then the best-effort
 * pubsub event is published for live waiters. A publish failure is
 * logged and swallowed so it can never derail the error-page render. The
 * waiter (`waitForOAuthCredential`) resolves `failed` ONLY from the
 * explicit event — the absence of a state row no longer implies failure,
 * because the row is deleted at the START of a seconds-long exchange.
 *
 * The state-not-found branch does NOT call this: with no claimed row
 * there is no tenant to scope either the audit row or the event to.
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
    const payload = ConnectorOauthCallbackFailedPayloadSchema.parse({
      connector_id: p.connector_id,
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

// Minimal HTML page rendered to the user's browser tab at the end of
// the OAuth dance. No JavaScript, no styling beyond inline CSS — the
// CLI doesn't depend on `window.opener.postMessage` callbacks (the
// engine writes the credential synchronously and the CLI's
// OAuthWaitView polls the credential row).
function renderCallbackPage(
  c: Parameters<Parameters<OpenAPIHono<AppEnv>["openapi"]>[1]>[0],
  page: CallbackPage,
): Response {
  const status = page.kind === "success" ? 200 : 400;
  const colour = page.kind === "success" ? "#16a34a" : "#dc2626";
  const safeTitle = escapeHtml(page.title);
  const safeMessage = escapeHtml(page.message);
  const body = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeTitle}</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #fafafa; color: #111; }
    main { max-width: 560px; margin: 96px auto; padding: 32px; background: #fff; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
    h1 { color: ${colour}; margin: 0 0 16px; font-size: 22px; }
    p { white-space: pre-wrap; line-height: 1.5; margin: 0; }
  </style>
</head>
<body>
  <main>
    <h1>${safeTitle}</h1>
    <p>${safeMessage}</p>
  </main>
</body>
</html>`;
  return c.body(body, status, { "content-type": "text/html; charset=utf-8" });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
