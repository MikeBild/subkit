import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { IdParam } from "../../../api/common-schemas.ts";
import { inspectMcpConnectorOperation, MCP_ERRORS } from "../../../api/operations/connector-mcp.ts";
import { toHonoRoute } from "../../../api/operations/hono.ts";
import { defineOperation, reject } from "../../../api/operations/index.ts";
import {
  AuditAction,
  readRequestSource,
  recordConnectorMcpAuthorizationFailed,
  recordConnectorMcpAuthorizationStarted,
  recordConnectorMcpAuthorized,
} from "../../../audit/index.ts";
import {
  claimMcpOAuthState,
  connectorSignIn,
  consumeStartGrant,
  discardMcpOAuthState,
  getConnector,
  insertMcpOAuthState,
  type OAuthFlowOrigin,
  oauthFlowOrigin,
  readMcpAuthorizationUrl,
  settleConnectorReauthorization,
} from "../../../connectors/index.ts";
import type { Db } from "../../../db/client.ts";
import { logger } from "../../../logging/index.ts";
import {
  buildMcpOAuthRedirectUri,
  clearMcpConnectorFailure,
  evictServer,
  getMcpConnector,
  MCP_CREDENTIAL_ENVIRONMENT,
  MCP_OAUTH_CALLBACK_PATH,
  makeMcpOAuthProvider,
  redactUpstreamDetail,
  sdkAuth,
} from "../../../mcp/index.ts";
import type { RequestSource } from "../../../observability/index.ts";
import { now } from "../../../utils/clock.ts";
import type { AppEnv } from "../../openapi.ts";
import {
  cockpitReturn,
  connectorBacklink,
  requestLocale,
  resultResponse,
  signedInPage,
  signInFailedPage,
} from "./signin-result.ts";
import { signalSignInFailed, signalSignInSucceeded } from "./signin-signals.ts";

const LOG_MODULE = "mcp_oauth";

const STATE_TTL_MS = 10 * 60_000;

const AuthorizeResponse = z
  .object({
    authorization_url: z
      .string()
      .url()
      .openapi({ description: "URL the operator's browser must open to grant access." }),
    state: z
      .string()
      .openapi({ description: "Opaque single-use correlation token for this flow." }),
  })
  .openapi("ConnectorMcpAuthorizeResponse");

const McpOAuthCallbackQuery = z.object({
  code: z.string().optional(),
  state: z.string().min(1),
  iss: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

const McpAuthorizeGrantQuery = z.object({ grant: z.string().min(20) });

const authorizeMcpConnectorOperation = defineOperation<
  { id: string },
  z.infer<typeof AuthorizeResponse>
>({
  id: "connector.mcp_authorize",
  summary: "Begin an interactive OAuth 2.1 authorization for an mcp connector",
  permission: "connector:oauth",
  resource: { type: "connector", param: "id" },
  effect: "write",
  audit: AuditAction.CONNECTOR_MCP_AUTHORIZATION_STARTED,
  handler: async (scope, { id }) => {
    const principal = scope.principal;
    if (!principal || !scope.request) return reject.unauthorized();
    const requestSource = scope.request_source ?? "api";
    const started = await startMcpAuthorization({
      db: scope.db,
      req: scope.request,
      tenant_id: scope.tenant_id,
      connector_id: id,
      actor_id: principal.id,
      actor_type: principal.kind,
      origin: requestSource === "ui" ? "cockpit" : "cli",
      request_source: requestSource,
    });
    if (started.ok) return started.flow;
    switch (started.failure) {
      case "not_found":
        return reject.notFound("mcp connector");
      case "not_this_route":
        return started.route
          ? reject.status(
              422,
              "sign_in_route_mismatch",
              "this connector does not sign in through mcp/authorize",
              undefined,
              `start its sign-in at ${started.route}`,
            )
          : reject.status(
              422,
              "no_browser_sign_in",
              "this connector has no browser sign-in — interactive authorization is only available for an mcp connector whose auth_type is 'oauth2'",
            );
      case "no_public_address":
        return reject.status(
          400,
          "engine_public_url_missing",
          "engine has no resolvable public origin — set server.public_base_url (it must be an HTTPS URL reachable by the external authorization server)",
        );
      case "start_failed":
        return reject.status(
          502,
          "mcp_authorization_failed",
          "could not begin authorization — the external MCP server's authorization-server discovery or dynamic client registration failed",
        );
    }
  },
  http: {
    method: "post",
    path: "/v1/connectors/{id}/mcp/authorize",
    tags: ["connectors"],
    params: IdParam,
    response: AuthorizeResponse,
    errors: { 400: "Bad request", ...MCP_ERRORS, 502: "Authorization-server discovery failed" },
    toInput: ({ param }) => param as { id: string },
    toBody: (result) => result,
  },
});

const authorizeGrantRoute = createRoute({
  method: "get",
  path: "/v1/connectors/{id}/mcp/authorize",
  tags: ["connectors"],
  summary: "Browser-openable OAuth 2.1 authorization for an mcp connector (single-use grant token)",
  request: { params: IdParam, query: McpAuthorizeGrantQuery },
  responses: {
    302: { description: "Redirect to the authorization server" },
    400: {
      description: "Grant invalid/expired, or the authorization could not begin (HTML page)",
      content: { "text/html": { schema: z.string() } },
    },
  },
});

const callbackRoute = createRoute({
  method: "get",
  path: MCP_OAUTH_CALLBACK_PATH,
  tags: ["connectors"],
  summary: "Complete an interactive OAuth 2.1 authorization for an mcp connector",
  request: { query: McpOAuthCallbackQuery },
  responses: {
    200: { description: "OK (HTML)", content: { "text/html": { schema: z.string() } } },
    303: { description: "Authorized — back to the connector's page in the Cockpit" },
    400: { description: "Bad request (HTML)", content: { "text/html": { schema: z.string() } } },
  },
});

export function registerConnectorMcpRoutes(app: OpenAPIHono<AppEnv>): void {
  toHonoRoute(app, inspectMcpConnectorOperation);
  toHonoRoute(app, authorizeMcpConnectorOperation);

  app.openapi(authorizeGrantRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const { grant } = c.req.valid("query");

    const claimed = await consumeStartGrant(db, { token: grant, connector_id: id });
    if (!claimed) {
      logger.warn({
        module: LOG_MODULE,
        action: "authorize.grant_invalid",
        msg: "start grant not found, expired, or wrong connector — browser opened an invalid link",
        connector_id: id,
      });
      return resultResponse(c, signInFailedPage(requestLocale(c), "chat", "link_expired"));
    }

    const { tenant_id, connector_id } = claimed;

    const started = await startMcpAuthorization({
      db,
      req: c.req.raw,
      tenant_id,
      connector_id,
      actor_id: null,
      actor_type: null,
      origin: "chat",
      request_source: readRequestSource(c) ?? "api",
    });
    if (started.ok) return c.redirect(started.flow.authorization_url, 302);
    const failure =
      started.failure === "not_found"
        ? "connector_gone"
        : started.failure === "no_public_address"
          ? "no_public_address"
          : "not_startable";
    return resultResponse(c, signInFailedPage(requestLocale(c), "chat", failure));
  });

  app.openapi(callbackRoute, async (c) => {
    const db = c.get("db");
    const q = c.req.valid("query");

    const stateRow = await claimMcpOAuthState(db, q.state, new Date(now()));
    if (!stateRow) {
      logger.warn({
        module: LOG_MODULE,
        action: "callback.state_not_found",
        msg: "no fresh mcp_oauth_states row matched the callback",
        state_prefix: q.state.slice(0, 8),
        had_code: Boolean(q.code),
        had_error: Boolean(q.error),
      });
      return resultResponse(c, signInFailedPage(requestLocale(c), null, "link_expired"));
    }

    const tenant_id = stateRow.tenant_id;
    const connector_id = stateRow.connector_id;
    const started_by_actor_type = stateRow.started_by_actor_type ?? "unknown";
    const started_by_actor_id = stateRow.started_by_actor_id ?? null;
    const requestSource: RequestSource = readRequestSource(c) ?? "api";
    const server = await getMcpConnector(db, tenant_id, connector_id);
    const connector_slug = server?.slug ?? "unknown";
    const auth = server?.auth ?? { kind: "none" as const };
    const issuerForAudit =
      ("issuer" in auth && auth.issuer ? auth.issuer : server?.url) ?? q.iss ?? "";

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

    const failAudit = async (
      reason:
        | "provider_error"
        | "missing_code"
        | "token_exchange_failed"
        | "server_not_found"
        | "issuer_mismatch",
    ): Promise<void> => {
      await recordConnectorMcpAuthorizationFailed({
        tenant_id,
        actor_id: started_by_actor_id,
        actor_type: started_by_actor_type,
        request_source: requestSource,
        connector_id,
        connector_slug,
        issuer: issuerForAudit,
        reason,
        executor: db,
      });
      await signalSignInFailed(db, {
        module: LOG_MODULE,
        tenant_id,
        connector_id,
        connector_slug: server?.slug ?? null,
        reason:
          reason === "provider_error" ||
          reason === "missing_code" ||
          reason === "token_exchange_failed"
            ? reason
            : null,
      });
    };

    if (q.error) {
      logger.warn({
        module: LOG_MODULE,
        action: "callback.provider_error",
        msg: "external authorization server returned an error",
        tenant_id,
        connector_id,
        state_prefix: stateRow.state.slice(0, 8),
        provider_error: q.error,
      });
      await failAudit("provider_error");
      return failed("provider_declined", q.error);
    }

    if (!server) {
      logger.warn({
        module: LOG_MODULE,
        action: "callback.server_gone",
        msg: "mcp connector row no longer exists for a claimed callback state",
        tenant_id,
        connector_id,
        state_prefix: stateRow.state.slice(0, 8),
      });
      await failAudit("server_not_found");
      return resultResponse(c, signInFailedPage(requestLocale(c), origin, "connector_gone"));
    }

    if (!q.code) {
      logger.warn({
        module: LOG_MODULE,
        action: "callback.missing_code",
        msg: "callback had neither code nor error",
        tenant_id,
        connector_id,
        state_prefix: stateRow.state.slice(0, 8),
      });
      await failAudit("missing_code");
      return failed("no_authorization");
    }

    if (q.iss && stateRow.as_issuer) {
      if (!sameOrigin(q.iss, stateRow.as_issuer)) {
        logger.warn({
          module: LOG_MODULE,
          action: "callback.issuer_mismatch",
          msg: "callback iss origin does not match the resource the flow began against",
          tenant_id,
          connector_id,
          state_prefix: stateRow.state.slice(0, 8),
        });
        await failAudit("issuer_mismatch");
        return failed("issuer_mismatch");
      }
    }

    try {
      const provider = makeMcpOAuthProvider({
        db,
        tenant_id,
        connector_id,
        environment: MCP_CREDENTIAL_ENVIRONMENT,
        redirect_uri: stateRow.redirect_uri,
        state: stateRow.state,
        auth,
        interactive: true,
        request_source: requestSource,
      });
      const result = await sdkAuth(provider, {
        serverUrl: server.url,
        authorizationCode: q.code,
        fetchFn: provider.fetch,
      });
      if (result !== "AUTHORIZED") {
        throw new Error(`token exchange did not authorize (auth() returned ${result})`);
      }

      await clearMcpConnectorFailure(db, server);
      await settleConnectorReauthorization(db, {
        tenant_id,
        connector_id,
        actor_id: started_by_actor_id,
        actor_type: started_by_actor_type,
      });

      await recordConnectorMcpAuthorized({
        tenant_id,
        actor_id: started_by_actor_id,
        actor_type: started_by_actor_type,
        request_source: requestSource,
        connector_id,
        connector_slug,
        issuer: issuerForAudit,
        executor: db,
      });

      await signalSignInSucceeded(db, {
        module: LOG_MODULE,
        tenant_id,
        connector_id,
        connector_slug,
        has_refresh_token: Boolean((await provider.tokens().catch(() => undefined))?.refresh_token),
      });

      evictServer(tenant_id, connector_id);

      logger.info({
        module: LOG_MODULE,
        action: "callback.success",
        msg: "external MCP server authorized via interactive OAuth",
        tenant_id,
        connector_id,
        connector_slug,
        state_prefix: stateRow.state.slice(0, 8),
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
            name: server.display_name,
            enabled: server.enabled,
            missing_scopes: [],
          },
          await connectorBacklink(c, db, { ...stateRow, origin }),
        ),
      );
    } catch (err) {
      logger.warn({
        module: LOG_MODULE,
        action: "callback.exchange_failed",
        msg: "token exchange or credential write failed",
        tenant_id,
        connector_id,
        state_prefix: stateRow.state.slice(0, 8),
        error_class: err instanceof Error ? err.name : "Error",
        error: redactUpstreamDetail(err instanceof Error ? err.message : String(err)),
      });
      await failAudit("token_exchange_failed");
      return failed("exchange_failed");
    }
  });
}

type McpAuthorizationStart =
  | { ok: true; flow: { authorization_url: string; state: string } }
  | { ok: false; failure: "not_found" }
  | { ok: false; failure: "not_this_route"; route: string | null }
  | { ok: false; failure: "no_public_address" }
  | { ok: false; failure: "start_failed" };

async function startMcpAuthorization(p: {
  db: Db;
  req: Request;
  tenant_id: string;
  connector_id: string;
  actor_id: string | null;
  actor_type: "user" | "system_account" | null;
  origin: OAuthFlowOrigin;
  request_source: RequestSource;
}): Promise<McpAuthorizationStart> {
  const { db, tenant_id, connector_id: id, actor_id } = p;

  const connector = await getConnector(tenant_id, id, db);
  if (!connector) return { ok: false, failure: "not_found" };
  const signIn = connectorSignIn(connector);
  if (signIn?.kind !== "mcp") {
    return { ok: false, failure: "not_this_route", route: signIn?.start ?? null };
  }
  const server = await getMcpConnector(db, tenant_id, id);
  if (!server) return { ok: false, failure: "not_found" };
  const auth = server.auth;
  if (auth.kind !== "oauth2") return { ok: false, failure: "not_this_route", route: null };

  const redirect_uri = buildMcpOAuthRedirectUri({ req: p.req });
  if (!redirect_uri) return { ok: false, failure: "no_public_address" };

  const state = crypto.randomUUID();

  await insertMcpOAuthState(db, {
    tenant_id,
    connector_id: id,
    state,
    code_verifier: "",
    redirect_uri,
    requested_scopes: auth.scope ?? null,
    started_by_actor_id: actor_id,
    started_by_actor_type: p.actor_type,
    origin: p.origin,
    expires_at: new Date(now() + STATE_TTL_MS),
  });

  const issuerForAudit = auth.issuer ?? server.url;
  try {
    const provider = makeMcpOAuthProvider({
      db,
      tenant_id,
      connector_id: id,
      environment: MCP_CREDENTIAL_ENVIRONMENT,
      redirect_uri,
      state,
      auth,
      interactive: true,
      request_source: p.request_source,
    });
    const result = await sdkAuth(provider, { serverUrl: server.url, fetchFn: provider.fetch });
    if (result !== "REDIRECT") {
      throw new Error(`unexpected auth() result for interactive flow: ${result}`);
    }

    const authorizationUrl = await readMcpAuthorizationUrl(db, tenant_id, state);
    if (!authorizationUrl) {
      throw new Error("authorization URL was not persisted by the OAuth provider");
    }

    await recordConnectorMcpAuthorizationStarted({
      tenant_id,
      actor_id,
      ...(p.actor_type ? { actor_type: p.actor_type } : {}),
      request_source: p.request_source,
      connector_id: id,
      connector_slug: server.slug,
      issuer: issuerForAudit,
      executor: db,
    });

    logger.info({
      module: LOG_MODULE,
      action: "authorize.started",
      msg: "issued interactive OAuth authorization URL for external MCP server",
      tenant_id,
      connector_id: id,
      connector_slug: server.slug,
      origin: p.origin,
      state_prefix: state.slice(0, 8),
    });

    return { ok: true, flow: { authorization_url: authorizationUrl, state } };
  } catch (err) {
    await discardMcpOAuthState(db, tenant_id, state);
    await recordConnectorMcpAuthorizationFailed({
      tenant_id,
      actor_id,
      ...(p.actor_type ? { actor_type: p.actor_type } : {}),
      request_source: p.request_source,
      connector_id: id,
      connector_slug: server.slug,
      issuer: issuerForAudit,
      reason: "discovery_or_registration_failed",
      executor: db,
    });
    logger.warn({
      module: LOG_MODULE,
      action: "authorize.failed",
      msg: "interactive OAuth authorization could not be started for external MCP server",
      tenant_id,
      connector_id: id,
      connector_slug: server.slug,
      error_class: err instanceof Error ? err.name : "Error",
      error: redactUpstreamDetail(err instanceof Error ? err.message : String(err)),
    });
    return { ok: false, failure: "start_failed" };
  }
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}
