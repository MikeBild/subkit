import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { IdParam } from "../../../api/common-schemas.ts";
import { toHonoRoute } from "../../../api/operations/hono.ts";
import { defineOperation, reject } from "../../../api/operations/index.ts";
import { AuditAction, actorOf, auditAwait } from "../../../audit/index.ts";
import * as connectorSvc from "../../../connectors/index.ts";
import {
  beginConnectorOAuthDance,
  claimConnectorOAuthState,
  consumeStartGrant,
  oauthFlowOrigin,
  settleConnectorReauthorization,
} from "../../../connectors/index.ts";
import * as credsvc from "../../../credentials/index.ts";
import {
  buildOAuthRedirectUri,
  completeAuthorizationCode,
  isOAuthProviderError,
} from "../../../credentials/index.ts";
import { logger } from "../../../logging/index.ts";
import { redactUpstreamDetail } from "../../../mcp/index.ts";
import { now } from "../../../utils/clock.ts";
import { BadRequestError, NotFoundError } from "../../errors.ts";
import type { AppEnv } from "../../openapi.ts";
import { OAuthCallbackQuery, OAuthStartResponse } from "./schemas.ts";
import {
  cockpitReturn,
  connectorBacklink,
  requestLocale,
  resultResponse,
  signedInPage,
  signInFailedPage,
} from "./signin-result.ts";
import {
  type SignInFailedReason,
  signalSignInFailed,
  signalSignInSucceeded,
} from "./signin-signals.ts";

const startOAuthOperation = defineOperation<{ id: string }, z.infer<typeof OAuthStartResponse>>({
  id: "connector.oauth_start",
  summary: "Begin an OAuth2 authorization-code flow",
  permission: "connector:oauth",
  resource: { type: "connector", param: "id" },
  effect: "write",
  audit: AuditAction.OAUTH_CLIENT_REGISTERED,
  handler: async (scope, { id }) => {
    const principal = scope.principal;
    if (!principal || !scope.request) return reject.unauthorized();
    const redirect_uri = buildOAuthRedirectUri({ req: scope.request });
    if (!redirect_uri) {
      return reject.status(
        400,
        "engine_public_url_missing",
        "engine has no resolvable public origin — set server.public_base_url",
      );
    }

    let result: Awaited<ReturnType<typeof beginConnectorOAuthDance>>;
    try {
      result = await beginConnectorOAuthDance({
        db: scope.db,
        tenant_id: principal.tenant_id,
        connector_id: id,
        actor_id: principal.id,
        actor: actorOf(principal),
        redirect_uri,
        origin: scope.request_source === "ui" ? "cockpit" : "cli",
      });
    } catch (err) {
      if (!isOAuthProviderError(err)) throw err;
      logger.warn({
        module: "oauth",
        action: "oauth.start.failed",
        msg: "OAuth sign-in could not be started at the sign-in service",
        tenant_id: principal.tenant_id,
        connector_id: id,
        error_class: err instanceof Error ? err.name : "Error",
        error: redactUpstreamDetail(err instanceof Error ? err.message : String(err)),
      });
      return reject.status(
        502,
        "oauth_start_failed",
        "could not begin sign-in — the sign-in service's discovery document is missing or does not match its issuer URL, or it refused the request",
      );
    }

    if (result.kind === "done") return { authorization_url: "", state: "" };
    return { authorization_url: result.authorization_url, state: result.state };
  },
  http: {
    method: "post",
    path: "/v1/connectors/{id}/oauth/start",
    tags: ["connectors"],
    params: IdParam,
    response: OAuthStartResponse,
    errors: {
      400: "Bad request",
      404: "Not found",
      502: "The sign-in service's discovery failed or it refused the request",
    },
    toInput: ({ param }) => param as { id: string },
    toBody: (result) => result,
  },
});

const OAuthStartGrantQuery = z
  .object({ grant: z.string().min(20) })
  .openapi("OAuthStartGrantQuery");

const oauthGrantStartRoute = createRoute({
  method: "get",
  path: "/v1/connectors/{id}/oauth/start",
  tags: ["connectors"],
  summary: "Browser-openable OAuth2 start (single-use grant token)",
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
  request: { query: OAuthCallbackQuery },
  responses: {
    200: { description: "OK (HTML)", content: { "text/html": { schema: z.string() } } },
    303: { description: "Signed in — back to the connector's page in the Cockpit" },
    400: { description: "Bad request (HTML)", content: { "text/html": { schema: z.string() } } },
  },
});

export function registerOAuthRoutes(app: OpenAPIHono<AppEnv>): void {
  toHonoRoute(app, startOAuthOperation);

  app.openapi(oauthGrantStartRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const { grant } = c.req.valid("query");

    const claimed = await consumeStartGrant(db, { token: grant, connector_id: id });
    if (!claimed) {
      logger.warn({
        module: "oauth",
        action: "oauth.grant_start.invalid",
        msg: "start grant not found, expired, or wrong connector — browser opened an invalid link",
        connector_id: id,
      });
      return resultResponse(c, signInFailedPage(requestLocale(c), "chat", "link_expired"));
    }

    const { tenant_id, connector_id } = claimed;

    const redirect_uri = buildOAuthRedirectUri({ req: c.req.raw });
    if (!redirect_uri) {
      return resultResponse(c, signInFailedPage(requestLocale(c), "chat", "no_public_address"));
    }

    try {
      const result = await beginConnectorOAuthDance({
        db,
        tenant_id,
        connector_id,
        actor_id: null,
        redirect_uri,
        origin: "chat",
      });

      if (result.kind === "done") {
        const connector = await connectorSvc.getConnector(tenant_id, connector_id, db);
        return resultResponse(
          c,
          signedInPage(
            requestLocale(c),
            "chat",
            {
              stored: "signed_in",
              name: connector?.display_name ?? connector?.slug ?? "",
              enabled: connector?.enabled ?? true,
              missing_scopes: [],
            },
            null,
          ),
        );
      }

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
      return resultResponse(c, signInFailedPage(requestLocale(c), "chat", "not_startable"));
    }
  });

  app.openapi(oauthCallbackRoute, async (c) => {
    const db = c.get("db");
    const q = c.req.valid("query");
    const stateRow = await claimConnectorOAuthState(db, q.state, new Date(now()));
    if (!stateRow) {
      logger.warn({
        module: "oauth",
        action: "oauth.callback.state_not_found",
        msg: "no fresh state row matched the callback",
        state_prefix: q.state.slice(0, 8),
        had_code: Boolean(q.code),
        had_error: Boolean(q.error),
      });
      return resultResponse(c, signInFailedPage(requestLocale(c), null, "link_expired"));
    }

    const origin = oauthFlowOrigin(stateRow.origin);
    const failed = async (
      failure: Parameters<typeof signInFailedPage>[2],
      provider_code?: string,
    ): Promise<Response> => {
      if (origin === "cockpit") {
        const back = cockpitReturn(stateRow, {
          kind: "signin_failed",
          failure,
          provider_code: provider_code ?? null,
        });
        if (back) return back;
      }
      return resultResponse(
        c,
        signInFailedPage(requestLocale(c), origin, failure, {
          provider_code: provider_code ?? null,
          backlink: await connectorBacklink(c, db, { ...stateRow, origin }),
        }),
      );
    };

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
      await publishCallbackFailed(db, {
        tenant_id: stateRow.tenant_id,
        connector_id: stateRow.connector_id,
        reason: "provider_error",
      });
      return failed("provider_declined", q.error);
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
      return failed("no_authorization");
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
      const bundle = await completeAuthorizationCode(
        {
          cfg: cfgWithRedirect,
          current_url: current,
          code_verifier: stateRow.code_verifier,
          state: stateRow.state,
        },
        { tenant_id: stateRow.tenant_id, exec: db },
      );
      const scopeDiff = connectorSvc.diffOauthScopes(stateRow.requested_scopes, bundle.scope);
      const requestedScopes = scopeDiff?.expected ?? [];
      const grantedScopes = scopeDiff?.granted ?? [];
      const isPartialGrant = scopeDiff?.partial_grant === true;
      const missingScopes = isPartialGrant ? (scopeDiff?.missing ?? []) : [];
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
          verified_identity: bundle.verified_identity ?? null,
          oauth2_expires_at: bundle.expires_at,
          oauth2_granted_scopes: bundle.scope ?? null,
          actor_id: null,
          source: "oauth_callback",
        },
        db,
      );
      await settleConnectorReauthorization(db, {
        tenant_id: stateRow.tenant_id,
        connector_id: stateRow.connector_id,
      });
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
      await signalSignInSucceeded(db, {
        module: "oauth",
        tenant_id: stateRow.tenant_id,
        connector_id: stateRow.connector_id,
        connector_slug: connector.slug,
        has_refresh_token: bundle.refresh_token != null,
      });
      if (origin === "cockpit") {
        const back = cockpitReturn(stateRow, { kind: "signed_in" });
        if (back) return back;
      }
      return resultResponse(
        c,
        signedInPage(
          requestLocale(c),
          origin,
          {
            stored: "signed_in",
            name: connector.display_name ?? connector.slug,
            enabled: connector.enabled,
            missing_scopes: missingScopes,
          },
          await connectorBacklink(c, db, { ...stateRow, origin }),
        ),
      );
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
      await publishCallbackFailed(db, {
        tenant_id: stateRow.tenant_id,
        connector_id: stateRow.connector_id,
        reason: "token_exchange_failed",
      });
      return failed("exchange_failed");
    }
  });
}

async function publishCallbackFailed(
  db: import("../../../db/client.ts").Db,
  p: {
    tenant_id: string;
    connector_id: string;
    reason: SignInFailedReason;
  },
): Promise<void> {
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
  const connector = await connectorSvc
    .getConnector(p.tenant_id, p.connector_id, db)
    .catch(() => null);
  await signalSignInFailed(db, {
    module: "oauth",
    tenant_id: p.tenant_id,
    connector_id: p.connector_id,
    connector_slug: connector?.slug ?? null,
    reason: p.reason,
  });
}
