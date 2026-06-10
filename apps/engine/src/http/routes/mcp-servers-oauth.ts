// Interactive browser OAuth 2.1 + PKCE onboarding for OAuth-only external
// MCP servers (#171 follow-up).
//
//   POST /v1/mcp-servers/{id}/authorize    — authenticated, gated
//                                            `mcp_server:manage`. Runs RFC
//                                            9728 PRM → RFC 8414 AS
//                                            discovery → RFC 7591 DCR →
//                                            PKCE through the SDK's `auth()`
//                                            driver, persists the resulting
//                                            authorization URL on a fresh
//                                            `mcp_oauth_states` row, and
//                                            returns it for the operator's
//                                            browser to open.
//
//   GET  /v1/mcp-servers/oauth/callback     — UNAUTHENTICATED. The external
//                                            server's authorization server
//                                            redirects the operator's
//                                            browser here with
//                                            `?code=…&state=…&iss=…`
//                                            (success) OR `?error=…&state=…`
//                                            (denial). The opaque single-use
//                                            `state` row carries tenant_id +
//                                            mcp_server_id, so the engine
//                                            routes the token write to the
//                                            right tenant with NO API key in
//                                            the browser session.
//
// AUTH MODEL (callback): the `state` token IS the authentication. The row
// is claimed with an atomic `DELETE … RETURNING` keyed on the unique
// `state` (single-use, TOCTOU-safe), tenant_id is read FROM THE ROW, and
// RFC 9207 `iss` is validated against the authorization-server origin the
// flow began against (persisted as `as_issuer` at authorize time).
// No principal, no API key. Mirrors the connector OAuth callback exactly.
//
// SECRET DISCIPLINE: no token, code_verifier, authorization URL, or
// URL-with-query string ever appears in a response, log, audit row, or
// error page. Token material lands only in the encrypted `credentials`
// table (written by the OAuth provider's `saveTokens`). GENERIC: no
// Atlassian/Rovo literal — discovery is driven by the SDK off the
// server URL.

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { and, eq, gt } from "drizzle-orm";
import { ErrorSchema, IdParam } from "../../api/common-schemas.ts";
import {
  readRequestSource,
  recordMcpServerAuthorizationFailed,
  recordMcpServerAuthorizationStarted,
  recordMcpServerAuthorized,
} from "../../audit/index.ts";
import type { Db } from "../../db/client.ts";
import { mcpOauthStates } from "../../db/schema/index.ts";
import { logger } from "../../logging/index.ts";
import {
  buildMcpOAuthRedirectUri,
  evictTenant,
  getMcpServer,
  MCP_CREDENTIAL_ENVIRONMENT,
  MCP_OAUTH_CALLBACK_PATH,
  type McpServerAuditCtx,
  makeMcpOAuthProvider,
  parseAuthConfig,
  redactLastError,
  sdkAuth,
  setMcpServerStatus,
} from "../../mcp/index.ts";
import type { RequestSource } from "../../observability/index.ts";
import { now } from "../../utils/clock.ts";
import { BadRequestError, HttpError, NotFoundError, UnprocessableEntityError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const LOG_MODULE = "mcp_oauth";

/** A pending authorization is short-lived: the operator must complete the
 *  browser round-trip before the row expires. */
const STATE_TTL_MS = 10 * 60_000;

// ── Zod schemas ──────────────────────────────────────────────────────────────

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
  .openapi("McpServerAuthorizeResponse");

// The authorization server redirects the browser here. `code`+`state` on
// success; `error`+`state` on denial. `iss` (RFC 9207) is validated when
// present.
const McpOAuthCallbackQuery = z.object({
  code: z.string().optional(),
  state: z.string().min(1),
  iss: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

// ── Route definitions ────────────────────────────────────────────────────────

const authorizeRoute = createRoute({
  method: "post",
  path: "/v1/mcp-servers/{id}/authorize",
  tags: ["mcp-servers"],
  summary: "Begin an interactive OAuth 2.1 authorization for an external MCP server",
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

const callbackRoute = createRoute({
  method: "get",
  path: MCP_OAUTH_CALLBACK_PATH,
  tags: ["mcp-servers"],
  summary: "Complete an interactive OAuth 2.1 authorization for an external MCP server",
  // Unauthenticated: the authorization server redirects the operator's
  // browser here with no API key. Authentication is by way of the opaque
  // single-use `state` token (unique index on mcp_oauth_states.state),
  // which carries the (tenant_id, mcp_server_id) pair.
  request: { query: McpOAuthCallbackQuery },
  responses: {
    200: { description: "OK (HTML)", content: { "text/html": { schema: z.string() } } },
    400: { description: "Bad request (HTML)", content: { "text/html": { schema: z.string() } } },
  },
});

// ── Registration ─────────────────────────────────────────────────────────────

export function registerMcpServerOAuthRoutes(app: OpenAPIHono<AppEnv>): void {
  // The authorize route is privileged and shares the same permission as the
  // rest of the MCP-server surface. The callback route is intentionally
  // NOT gated — it is state-token-authed, not API-key-authed.
  app.use("/v1/mcp-servers/:id/authorize", requirePermission("mcp_server:manage"));

  app.openapi(authorizeRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const requestSource: RequestSource = readRequestSource(c) ?? "api";

    const server = await getMcpServer(db, principal.tenant_id, id);
    if (!server) throw new NotFoundError("mcp_server");

    const auth = parseAuthConfig(server.auth_config ?? null);
    if (auth.kind !== "oauth2") {
      throw new UnprocessableEntityError(
        "interactive authorization is only available for an MCP server with auth_config.kind 'oauth2'",
      );
    }

    const redirect_uri = buildMcpOAuthRedirectUri({ req: c.req.raw });
    if (!redirect_uri) {
      throw new BadRequestError(
        "engine has no resolvable public origin — set server.public_base_url (it must be an HTTPS URL reachable by the external authorization server)",
      );
    }

    // Opaque correlation token. crypto.randomUUID is the same RNG the
    // connector flow relies on for an unguessable single-use state.
    const state = crypto.randomUUID();

    // Placeholder row at flow start, mirroring connectorOauthStates: the
    // SDK driver fills in code_verifier + authorization_url via the
    // provider's callbacks below.
    await db.insert(mcpOauthStates).values({
      tenant_id: principal.tenant_id,
      mcp_server_id: id,
      state,
      code_verifier: "",
      redirect_uri,
      requested_scopes: auth.scope ?? null,
      expires_at: new Date(now() + STATE_TTL_MS),
    });

    const issuerForAudit = auth.issuer ?? server.url;
    try {
      const provider = makeMcpOAuthProvider({
        db,
        tenant_id: principal.tenant_id,
        mcp_server_id: id,
        environment: MCP_CREDENTIAL_ENVIRONMENT,
        redirect_uri,
        state,
        auth,
        interactive: true,
        request_source: requestSource,
      });
      // Drive PRM → AS discovery → DCR → PKCE. With no authorizationCode the
      // driver builds the authorization URL, calls provider.saveCodeVerifier
      // + provider.redirectToAuthorization (which persists the URL on the
      // row), and returns "REDIRECT".
      const result = await sdkAuth(provider, { serverUrl: server.url });
      if (result !== "REDIRECT") {
        // "AUTHORIZED" here would mean a live token already satisfied the
        // server with no browser step — not the interactive contract this
        // route promises. Treat it as a flow error so the operator isn't
        // handed a stale/empty authorization URL.
        throw new Error(`unexpected auth() result for interactive flow: ${result}`);
      }

      // Re-read the row to pick up the authorization URL the provider just
      // persisted.
      const rows = await db
        .select({ authorization_url: mcpOauthStates.authorization_url })
        .from(mcpOauthStates)
        .where(
          and(eq(mcpOauthStates.tenant_id, principal.tenant_id), eq(mcpOauthStates.state, state)),
        )
        .limit(1);
      const authorizationUrl = rows[0]?.authorization_url;
      if (!authorizationUrl) {
        throw new Error("authorization URL was not persisted by the OAuth provider");
      }

      await recordMcpServerAuthorizationStarted({
        tenant_id: principal.tenant_id,
        actor_id: principal.id,
        request_source: requestSource,
        mcp_server_id: id,
        namespace: server.namespace,
        issuer: issuerForAudit,
        executor: db,
      });

      logger.info({
        module: LOG_MODULE,
        action: "authorize.started",
        msg: "issued interactive OAuth authorization URL for external MCP server",
        tenant_id: principal.tenant_id,
        mcp_server_id: id,
        namespace: server.namespace,
        state_prefix: state.slice(0, 8),
      });

      return c.json({ authorization_url: authorizationUrl, state }, 200);
    } catch (err) {
      // Roll back the placeholder row so a failed discovery/DCR leaves no
      // orphan in-flight authorization.
      await db
        .delete(mcpOauthStates)
        .where(
          and(eq(mcpOauthStates.tenant_id, principal.tenant_id), eq(mcpOauthStates.state, state)),
        );
      // `reason` is a sanitized classifier, never the verbose error (it can
      // embed a discovery/authorization URL with a query string).
      await recordMcpServerAuthorizationFailed({
        tenant_id: principal.tenant_id,
        actor_id: principal.id,
        request_source: requestSource,
        mcp_server_id: id,
        namespace: server.namespace,
        issuer: issuerForAudit,
        reason: "discovery_or_registration_failed",
        executor: db,
      });
      logger.warn({
        module: LOG_MODULE,
        action: "authorize.failed",
        msg: "interactive OAuth authorization could not be started for external MCP server",
        tenant_id: principal.tenant_id,
        mcp_server_id: id,
        namespace: server.namespace,
        error_class: err instanceof Error ? err.name : "Error",
        // Raw discovery/DCR errors can embed a full URL with its query
        // string; reduce every embedded URL to host-only + length-cap.
        error: redactLastError(err instanceof Error ? err.message : String(err)),
      });
      // 502: the failure is almost always a remote discovery / DCR fault
      // (the external AS), not a malformed client request. No URL/secret in
      // the surfaced message.
      throw new HttpError(
        502,
        "mcp_authorization_failed",
        "could not begin authorization — the external MCP server's authorization-server discovery or dynamic client registration failed",
      );
    }
  });

  app.openapi(callbackRoute, async (c) => {
    const db = c.get("db");
    const q = c.req.valid("query");

    // Atomic single-use claim: DELETE … RETURNING the fresh state row. Two
    // callbacks racing on the same `state` — only one wins; the loser sees
    // no row and renders the expired/used page. Removes the read / exchange
    // / delete TOCTOU window.
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
      return renderCallbackPage(c, {
        kind: "error",
        title: "Authorization link expired",
        message:
          "This authorization link has expired or was already used. Close this tab and start the authorization again.",
      });
    }

    const tenant_id = stateRow.tenant_id;
    const mcp_server_id = stateRow.mcp_server_id;
    const requestSource: RequestSource = readRequestSource(c) ?? "api";
    const server = await getMcpServer(db, tenant_id, mcp_server_id);
    // namespace/issuer for the audit trail; fall back to safe placeholders
    // if the server row vanished mid-flow (delete race) so audit never throws.
    const namespace = server?.namespace ?? "unknown";
    const auth = server ? parseAuthConfig(server.auth_config ?? null) : { kind: "none" as const };
    const issuerForAudit =
      ("issuer" in auth && auth.issuer ? auth.issuer : server?.url) ?? q.iss ?? "";

    const failAudit = (reason: string): Promise<unknown> =>
      recordMcpServerAuthorizationFailed({
        tenant_id,
        actor_id: null,
        request_source: requestSource,
        mcp_server_id,
        namespace,
        issuer: issuerForAudit,
        reason,
        executor: db,
      });

    // Provider error path — operator denied access, scope rejected, etc.
    if (q.error) {
      logger.warn({
        module: LOG_MODULE,
        action: "callback.provider_error",
        msg: "external authorization server returned an error",
        tenant_id,
        mcp_server_id,
        state_prefix: stateRow.state.slice(0, 8),
        provider_error: q.error,
      });
      await failAudit("provider_error");
      return renderCallbackPage(c, {
        kind: "error",
        title: "Authorization was declined",
        message:
          q.error_description ??
          "The external authorization server declined the request. Close this tab and try again.",
      });
    }

    if (!server) {
      logger.warn({
        module: LOG_MODULE,
        action: "callback.server_gone",
        msg: "mcp server row no longer exists for a claimed callback state",
        tenant_id,
        mcp_server_id,
        state_prefix: stateRow.state.slice(0, 8),
      });
      await failAudit("server_not_found");
      return renderCallbackPage(c, {
        kind: "error",
        title: "Server no longer registered",
        message:
          "The MCP server this authorization belonged to is no longer registered. Close this tab.",
      });
    }

    if (!q.code) {
      logger.warn({
        module: LOG_MODULE,
        action: "callback.missing_code",
        msg: "callback had neither code nor error",
        tenant_id,
        mcp_server_id,
        state_prefix: stateRow.state.slice(0, 8),
      });
      await failAudit("missing_code");
      return renderCallbackPage(c, {
        kind: "error",
        title: "Authorization incomplete",
        message:
          "The authorization server redirected back without an authorization code. Close this tab and start the authorization again.",
      });
    }

    // RFC 9207 issuer validation: when the AS echoes `iss`, its origin must
    // match the authorization-server origin (`as_issuer`) the flow began
    // against — persisted at authorize time by the provider's
    // redirectToAuthorization. A mismatch means the code came back from a
    // different authorization server (mix-up attack), so we refuse to
    // exchange. `as_issuer` is always populated for an interactive flow, so
    // whenever the IdP sends `iss` the comparison runs.
    if (q.iss && stateRow.as_issuer) {
      if (!sameOrigin(q.iss, stateRow.as_issuer)) {
        logger.warn({
          module: LOG_MODULE,
          action: "callback.issuer_mismatch",
          msg: "callback iss origin does not match the resource the flow began against",
          tenant_id,
          mcp_server_id,
          state_prefix: stateRow.state.slice(0, 8),
        });
        await failAudit("issuer_mismatch");
        return renderCallbackPage(c, {
          kind: "error",
          title: "Authorization rejected",
          message:
            "The authorization response came from an unexpected authorization server and was rejected. Close this tab and start the authorization again.",
        });
      }
    }

    try {
      const provider = makeMcpOAuthProvider({
        db,
        tenant_id,
        mcp_server_id,
        environment: MCP_CREDENTIAL_ENVIRONMENT,
        redirect_uri: stateRow.redirect_uri,
        state: stateRow.state,
        auth,
        interactive: true,
        request_source: requestSource,
      });
      // Exchange the code: the driver reads the PKCE verifier off the row
      // (provider.codeVerifier), exchanges with the RFC 8707 resource
      // indicator, and calls provider.saveTokens (encrypted credentials).
      const result = await sdkAuth(provider, {
        serverUrl: server.url,
        authorizationCode: q.code,
      });
      if (result !== "AUTHORIZED") {
        throw new Error(`token exchange did not authorize (auth() returned ${result})`);
      }

      // Recover the server to active + clear any stale last_error now that a
      // live token exists.
      await setMcpServerStatus(
        db,
        tenant_id,
        mcp_server_id,
        "active",
        callbackAuditCtx(db, requestSource),
        {
          reason: "oauth_authorized",
        },
      );

      await recordMcpServerAuthorized({
        tenant_id,
        actor_id: null,
        request_source: requestSource,
        mcp_server_id,
        namespace,
        issuer: issuerForAudit,
        executor: db,
      });

      // Evict the tenant's pooled clients so the NEXT palette handshake
      // reconnects fresh with the token just written. Without this the
      // in-memory backoff window armed when the server was un-authorized
      // would keep skipping it for minutes — the server would stay dark
      // despite being authorized. evictTenant drops the cached client AND
      // the backoff entry, so the new token is used immediately.
      evictTenant(tenant_id);

      logger.info({
        module: LOG_MODULE,
        action: "callback.success",
        msg: "external MCP server authorized via interactive OAuth",
        tenant_id,
        mcp_server_id,
        namespace,
        state_prefix: stateRow.state.slice(0, 8),
      });

      return renderCallbackPage(c, {
        kind: "success",
        title: "Authorization complete",
        message: `The MCP server "${server.name}" is now authorized. You can close this window and return to your session.`,
      });
    } catch (err) {
      logger.warn({
        module: LOG_MODULE,
        action: "callback.exchange_failed",
        msg: "token exchange or credential write failed",
        tenant_id,
        mcp_server_id,
        state_prefix: stateRow.state.slice(0, 8),
        error_class: err instanceof Error ? err.name : "Error",
        // Raw exchange errors can embed the token-endpoint URL with its
        // query string; reduce every embedded URL to host-only + length-cap.
        error: redactLastError(err instanceof Error ? err.message : String(err)),
      });
      await failAudit("token_exchange_failed");
      return renderCallbackPage(c, {
        kind: "error",
        title: "Authorization failed",
        message:
          "The authorization code could not be exchanged for an access token. Close this tab and start the authorization again.",
      });
    }
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Origin-only comparison for RFC 9207 issuer validation. Both inputs are
 *  parsed as URLs; a non-URL value never matches. */
function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/** Audit envelope for the callback — there is no principal (anonymous
 *  browser hit). `actor_id: null` resolves to `actor_type: "system"`. The
 *  request-scoped db is the executor so audit writes land on the same pool
 *  the route already uses (required for integration-test isolation). */
function callbackAuditCtx(db: Db, requestSource: RequestSource): McpServerAuditCtx {
  return { actor_id: null, request_source: requestSource, executor: db };
}

interface CallbackPage {
  kind: "success" | "error";
  title: string;
  message: string;
}

/** Minimal, JS-free HTML page rendered to the operator's browser tab at the
 *  end of the OAuth dance. Mirrors the connector callback page. Never
 *  carries a token, URL with a query string, or any secret. */
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
