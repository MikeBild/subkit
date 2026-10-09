import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { classifyMcpToolSideEffect } from "@shared/index.ts";
import { and, eq, gt } from "drizzle-orm";
import { ErrorSchema, IdParam } from "../../../api/common-schemas.ts";
import {
  AuditAction,
  auditAwait,
  readRequestSource,
  recordConnectorMcpAuthorizationFailed,
  recordConnectorMcpAuthorizationStarted,
  recordConnectorMcpAuthorized,
} from "../../../audit/index.ts";
import {
  connectorSignIn,
  consumeStartGrant,
  getConnector,
  type OAuthFlowOrigin,
  oauthFlowOrigin,
  settleConnectorReauthorization,
} from "../../../connectors/index.ts";
import type { Db } from "../../../db/client.ts";
import { mcpOauthStates } from "../../../db/schema/index.ts";
import { logger } from "../../../logging/index.ts";
import {
  buildMcpOAuthRedirectUri,
  clearMcpConnectorFailure,
  connectServerById,
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
import { HttpError, NotFoundError, UnprocessableEntityError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
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

const InspectResponse = z
  .object({
    connector_id: z.string(),
    slug: z.string(),
    tools: z.array(
      z.object({
        name: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
        input_schema: z.record(z.string(), z.unknown()).nullable(),
        claims: z.enum(["read", "write"]).optional(),
      }),
    ),
    capabilities: z
      .object({ tools: z.boolean(), resources: z.boolean(), prompts: z.boolean() })
      .nullable(),
    instructions: z.string().nullable(),
    server_version: z.record(z.string(), z.unknown()).nullable(),
  })
  .openapi("ConnectorMcpInspectResponse");

const McpOAuthCallbackQuery = z.object({
  code: z.string().optional(),
  state: z.string().min(1),
  iss: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

const McpAuthorizeGrantQuery = z.object({ grant: z.string().min(20) });

const inspectRoute = createRoute({
  method: "post",
  path: "/v1/connectors/{id}/mcp/inspect",
  tags: ["connectors"],
  summary: "Force one handshake against an mcp connector and report what it serves",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: InspectResponse } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    422: { description: "Invalid", content: { "application/json": { schema: ErrorSchema } } },
    502: {
      description: "Handshake failed",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const authorizeRoute = createRoute({
  method: "post",
  path: "/v1/connectors/{id}/mcp/authorize",
  tags: ["connectors"],
  summary: "Begin an interactive OAuth 2.1 authorization for an mcp connector",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: AuthorizeResponse } } },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    422: { description: "Invalid", content: { "application/json": { schema: ErrorSchema } } },
    502: {
      description: "Authorization-server discovery failed",
      content: { "application/json": { schema: ErrorSchema } },
    },
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
  app.openapi(inspectRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const requestSource: RequestSource = readRequestSource(c) ?? "api";

    const connector = await getMcpConnector(db, principal.tenant_id, id);
    if (!connector) throw new NotFoundError("mcp connector");

    const outcome = await connectServerById(db, principal.tenant_id, id, {
      environment: MCP_CREDENTIAL_ENVIRONMENT,
      requestSource,
    });
    if (!outcome.ok) {
      if (outcome.reason === "disabled") {
        throw new UnprocessableEntityError(
          "this mcp connector is disabled — enable it before inspecting",
        );
      }
      throw new HttpError(
        502,
        "mcp_handshake_failed",
        outcome.detail ?? "the external MCP server refused the handshake",
      );
    }
    const set = outcome.tools;
    return c.json(
      {
        connector_id: id,
        slug: set.slug,
        tools: set.tools.map((t) => ({
          name: t.name,
          ...(t.title !== undefined ? { title: t.title } : {}),
          ...(t.description !== undefined ? { description: t.description } : {}),
          input_schema: t.inputSchema ?? null,
          ...(t.annotations ? { claims: classifyMcpToolSideEffect(t.annotations) } : {}),
        })),
        capabilities: set.capabilities,
        instructions: set.instructions,
        server_version: set.server_version,
      },
      200,
    );
  });

  app.openapi(authorizeRoute, async (c) => {
    const principal = requireAuth(c);
    const { id } = c.req.valid("param");
    const requestSource: RequestSource = readRequestSource(c) ?? "api";
    const started = await startMcpAuthorization({
      db: c.get("db"),
      req: c.req.raw,
      tenant_id: principal.tenant_id,
      connector_id: id,
      actor_id: principal.id,
      origin: requestSource === "ui" ? "cockpit" : "cli",
      request_source: requestSource,
    });
    if (started.ok) return c.json(started.flow, 200);
    switch (started.failure) {
      case "not_found":
        throw new NotFoundError("mcp connector");
      case "not_this_route":
        throw started.route
          ? new HttpError(
              422,
              "sign_in_route_mismatch",
              "this connector does not sign in through mcp/authorize",
              { hint: `start its sign-in at ${started.route}` },
            )
          : new HttpError(
              422,
              "no_browser_sign_in",
              "this connector has no browser sign-in — interactive authorization is only available for an mcp connector whose auth_type is 'oauth2'",
            );
      case "no_public_address":
        throw new HttpError(
          400,
          "engine_public_url_missing",
          "engine has no resolvable public origin — set server.public_base_url (it must be an HTTPS URL reachable by the external authorization server)",
        );
      case "start_failed":
        throw new HttpError(
          502,
          "mcp_authorization_failed",
          "could not begin authorization — the external MCP server's authorization-server discovery or dynamic client registration failed",
        );
    }
  });

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

    const { tenant_id, connector_id, created_by_actor_id } = claimed;

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

    const started = await startMcpAuthorization({
      db,
      req: c.req.raw,
      tenant_id,
      connector_id,
      actor_id: null,
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

    // tenant-filter:exempt — unauthenticated callback. The opaque single-use
    // `state` (unique index on mcp_oauth_states.state) IS the auth proof;
    // tenant_id is read from the matched row and used for every subsequent
    // write.
    // pattern: state-token-auth-callback — see also the connector OAuth
    // callback (http/routes/connectors/oauth.ts), which applies the same
    // claim-then-derive-tenant discipline.
    const claimed = await db
      .delete(mcpOauthStates)
      .where(and(eq(mcpOauthStates.state, q.state), gt(mcpOauthStates.expires_at, new Date(now()))))
      .returning();
    const stateRow = claimed[0];
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
      });

      await recordConnectorMcpAuthorized({
        tenant_id,
        actor_id: started_by_actor_id,
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

  await db.insert(mcpOauthStates).values({
    tenant_id,
    connector_id: id,
    state,
    code_verifier: "",
    redirect_uri,
    requested_scopes: auth.scope ?? null,
    started_by_actor_id: actor_id,
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

    const rows = await db
      .select({ authorization_url: mcpOauthStates.authorization_url })
      .from(mcpOauthStates)
      .where(and(eq(mcpOauthStates.tenant_id, tenant_id), eq(mcpOauthStates.state, state)))
      .limit(1);
    const authorizationUrl = rows[0]?.authorization_url;
    if (!authorizationUrl) {
      throw new Error("authorization URL was not persisted by the OAuth provider");
    }

    await recordConnectorMcpAuthorizationStarted({
      tenant_id,
      actor_id,
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
    await db
      .delete(mcpOauthStates)
      .where(and(eq(mcpOauthStates.tenant_id, tenant_id), eq(mcpOauthStates.state, state)));
    await recordConnectorMcpAuthorizationFailed({
      tenant_id,
      actor_id,
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
