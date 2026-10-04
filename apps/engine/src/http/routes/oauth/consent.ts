import type { OpenAPIHono } from "@hono/zod-openapi";
import { and, eq, isNull } from "drizzle-orm";
import type { Context } from "hono";
import {
  AuditAction,
  auditAwait,
  readRequestSource,
  SYSTEM_TENANT_ID,
} from "../../../audit/index.ts";
import {
  CLI_LOGIN_SCOPE,
  createMcpOAuthProvider,
  oauthResource,
  signLoginState,
} from "../../../auth/index.ts";
import { getConfig } from "../../../config/loader.ts";
import { roles as rolesTable, sessions, tenants, users } from "../../../db/schema/index.ts";
import { logger } from "../../../logging/index.ts";
import type { AppEnv } from "../../openapi.ts";
import {
  AuthorizeQuerySchema,
  buildErrorRedirect,
  DecisionRequestSchema,
  deriveSessionSecret,
  intersectScopes,
  MCP_SCOPE_PERMISSIONS,
  METRICS_SCOPE,
  parseFormBody,
  permittedMcpScopes,
  resolveSession,
  sessionIsLive,
  signCsrfToken,
  verifyCsrfToken,
} from "./shared.ts";
import {
  AUTHORIZE_INVALID_MESSAGE,
  authHtmlResponse,
  renderConsentPage,
  renderErrorPage,
  resolveAuthLocale,
  SIGN_IN_FAILED_TITLE,
  STATE_ERROR_MESSAGE,
} from "./ui.ts";

function authorizeBrowserError(
  c: Context<AppEnv>,
  error: string,
  errorDescription: string,
): Response {
  if ((c.req.header("accept") ?? "").includes("application/json")) {
    return c.json({ error, error_description: errorDescription }, 400);
  }
  return authHtmlResponse(
    renderErrorPage(SIGN_IN_FAILED_TITLE, AUTHORIZE_INVALID_MESSAGE, "/v1/identity/login/start"),
    400,
  );
}

export function registerOAuthConsentRoutes(app: OpenAPIHono<AppEnv>): void {
  app.get("/v1/oauth/authorize", async (c) => {
    const q = AuthorizeQuerySchema.safeParse(c.req.query());
    if (!q.success) {
      return authorizeBrowserError(c, "invalid_request", "invalid authorize parameters");
    }
    const clientId = q.data.client_id;
    const redirectUri = q.data.redirect_uri;
    const responseType = q.data.response_type;
    const codeChallenge = q.data.code_challenge;
    const codeChallengeMethod = q.data.code_challenge_method;
    const scopeParam = q.data.scope;
    const target = oauthResource(getConfig().server.public_base_url, q.data.resource);
    const state = q.data.state ?? "";

    const db = c.get("db");
    const provider = createMcpOAuthProvider({ db, config: getConfig() });
    const client = await provider.getClient(clientId);

    if (!client) {
      await auditAwait(
        {
          tenant_id: SYSTEM_TENANT_ID,
          actor_type: "system",
          action: AuditAction.AUTH_TOKEN_REJECTED,
          resource_type: "mcp_oauth_client",
          resource_id: clientId,
          result: "denied",
          metadata: {
            request_source: readRequestSource(c),
            reason: "unknown_client_id",
            client_id: clientId,
          },
        },
        db,
      );
      return authorizeBrowserError(c, "invalid_client", "unknown client_id");
    }

    if (!client.redirect_uris.includes(redirectUri)) {
      await auditAwait(
        {
          tenant_id: SYSTEM_TENANT_ID,
          actor_type: "system",
          action: AuditAction.AUTH_TOKEN_REJECTED,
          resource_type: "mcp_oauth_client",
          resource_id: clientId,
          result: "denied",
          metadata: {
            request_source: readRequestSource(c),
            reason: "unregistered_redirect_uri",
            client_id: clientId,
            redirect_uri: redirectUri,
          },
        },
        db,
      );
      return authorizeBrowserError(c, "invalid_request", "redirect_uri not registered");
    }

    if (!target) return buildErrorRedirect(redirectUri, "invalid_target", state);
    const resource = target.resource;

    if (responseType !== "code") {
      await auditAwait(
        {
          tenant_id: SYSTEM_TENANT_ID,
          actor_type: "system",
          action: AuditAction.AUTH_TOKEN_REJECTED,
          resource_type: "mcp_oauth_client",
          resource_id: clientId,
          result: "denied",
          metadata: {
            request_source: readRequestSource(c),
            reason: "unsupported_response_type",
            client_id: clientId,
          },
        },
        db,
      );
      return buildErrorRedirect(redirectUri, "unsupported_response_type", state);
    }

    if (!codeChallenge || codeChallengeMethod !== "S256") {
      await auditAwait(
        {
          tenant_id: SYSTEM_TENANT_ID,
          actor_type: "system",
          action: AuditAction.AUTH_TOKEN_REJECTED,
          resource_type: "mcp_oauth_client",
          resource_id: clientId,
          result: "denied",
          metadata: {
            request_source: readRequestSource(c),
            reason: "bad_pkce",
            client_id: clientId,
          },
        },
        db,
      );
      return buildErrorRedirect(redirectUri, "invalid_request", state);
    }

    const sessionPayload = await resolveSession(c.req.raw);
    const externalAuthorizeUrl = (() => {
      const u = new URL(c.req.url);
      const base = new URL(provider.getBaseUrl());
      u.protocol = base.protocol;
      u.host = base.host;
      return u.toString();
    })();
    if (!sessionPayload) {
      const loginUrl = new URL(`/v1/identity/login/start`, provider.getBaseUrl());
      loginUrl.searchParams.set(
        "login_state",
        await signLoginState({ redirect_to: externalAuthorizeUrl }),
      );
      return Response.redirect(loginUrl.toString(), 302);
    }

    if (!(await sessionIsLive(db, sessionPayload.session_id, sessionPayload.tenant_id))) {
      const loginUrl = new URL(`/v1/identity/login/start`, provider.getBaseUrl());
      loginUrl.searchParams.set(
        "login_state",
        await signLoginState({ redirect_to: externalAuthorizeUrl }),
      );
      return Response.redirect(loginUrl.toString(), 302);
    }

    const userRows = await db
      .select({ email: users.email, role_name: rolesTable.name })
      .from(users)
      .leftJoin(rolesTable, eq(rolesTable.id, users.role_id))
      .where(
        and(
          eq(users.id, sessionPayload.user_id),
          eq(users.tenant_id, sessionPayload.tenant_id),
          isNull(users.deleted_at),
          eq(users.status, "active"),
        ),
      )
      .limit(1);
    const userRow = userRows[0];
    if (!userRow) {
      await auditAwait(
        {
          tenant_id: sessionPayload.tenant_id,
          actor_type: "user",
          actor_id: sessionPayload.user_id,
          action: AuditAction.MCP_OAUTH_CONSENT_DENIED,
          resource_type: "mcp_oauth_client",
          resource_id: clientId,
          result: "denied",
          reason: "account_not_active",
          metadata: { session_id: sessionPayload.session_id },
        },
        db,
      );
      logger.warn({
        module: "mcp_oauth",
        action: "oauth.authorize.account_not_active",
        msg: "an account that is disabled or deleted reached the consent screen; denied",
        tenant_id: sessionPayload.tenant_id,
        user_id: sessionPayload.user_id,
        client_id: clientId,
      });
      return buildErrorRedirect(redirectUri, "access_denied", state);
    }

    const tenantRows = await db
      .select({ display_name: tenants.display_name })
      .from(tenants)
      .where(eq(tenants.id, sessionPayload.tenant_id))
      .limit(1);
    const tenantRow = tenantRows[0];

    let supportedScopes: string[] =
      target.kind === "cli_login" ? [CLI_LOGIN_SCOPE] : [...MCP_SCOPE_PERMISSIONS];
    if (target.kind === "mcp") {
      try {
        supportedScopes = getConfig().auth.mcp_oauth.scopes_supported;
      } catch {}
    }
    const registeredScope =
      client.scope || (target.kind === "cli_login" ? CLI_LOGIN_SCOPE : "mcp:read");
    const requestedScope = scopeParam ?? registeredScope;
    const roleScopes =
      target.kind === "cli_login"
        ? [CLI_LOGIN_SCOPE]
        : await permittedMcpScopes(
            db,
            sessionPayload.tenant_id,
            sessionPayload.user_id,
            userRow.role_name,
          );
    const scopeOrder =
      target.kind === "cli_login"
        ? ([CLI_LOGIN_SCOPE] as readonly string[])
        : (MCP_SCOPE_PERMISSIONS as readonly string[]);
    const clientBoundScopes = intersectScopes(
      requestedScope,
      registeredScope.split(" ").filter(Boolean),
    );
    const requestBoundScopes = intersectScopes(clientBoundScopes, supportedScopes);
    const offeredScopes = intersectScopes(requestBoundScopes, roleScopes)
      .split(" ")
      .filter(Boolean)
      .sort((a, b) => scopeOrder.indexOf(a) - scopeOrder.indexOf(b));

    const requestedSet = new Set(requestedScope.split(" ").filter(Boolean));
    const explicitlyRequested = new Set((scopeParam ?? "").split(" ").filter(Boolean));
    const preChecked = offeredScopes.filter((s) =>
      s === METRICS_SCOPE ? explicitlyRequested.has(s) : requestedSet.has(s) || s === "mcp:read",
    );

    const hasEntitlement =
      target.kind === "cli_login"
        ? offeredScopes.includes(CLI_LOGIN_SCOPE)
        : offeredScopes.length > 0;
    if (!hasEntitlement) {
      await auditAwait(
        {
          tenant_id: sessionPayload.tenant_id,
          actor_type: "user",
          actor_id: sessionPayload.user_id,
          action: AuditAction.MCP_OAUTH_CONSENT_DENIED,
          resource_type: "mcp_oauth_client",
          resource_id: clientId,
          result: "denied",
          reason: target.kind === "cli_login" ? "no_cli_login_entitlement" : "no_mcp_entitlement",
          metadata: {
            role: userRow.role_name,
            requested_scope: requestedScope,
          },
        },
        db,
      );
      logger.warn({
        module: "mcp_oauth",
        action: "oauth.authorize.no_entitlement",
        msg: "account holds no mcp:* permission; consent denied",
        tenant_id: sessionPayload.tenant_id,
        user_id: sessionPayload.user_id,
        client_id: clientId,
        role: userRow.role_name,
      });
      return buildErrorRedirect(redirectUri, "access_denied", state);
    }

    const csrfSecret = deriveSessionSecret();
    const csrfToken = await signCsrfToken(csrfSecret, {
      session_id: sessionPayload.session_id,
      client_id: clientId,
      redirect_uri: redirectUri,
      offered_scopes: offeredScopes.join(" "),
      code_challenge: codeChallenge,
      code_challenge_method: codeChallengeMethod,
      resource,
      state,
    });

    const html = renderConsentPage({
      clientName: client.client_name ?? clientId,
      clientUri: client.client_uri ?? null,
      locale: resolveAuthLocale(c.req.header("accept-language")),
      tenantName: tenantRow?.display_name ?? sessionPayload.tenant_id,
      userEmail: userRow.email,
      offeredScopes,
      preChecked,
      csrfToken,
      state,
      clientId,
      redirectUri,
      resource,
    });

    return authHtmlResponse(html);
  });

  app.post("/v1/oauth/authorize/decision", async (c) => {
    const form = await parseFormBody(c.req.raw);
    const selectedScopes = form.getAll("scope");
    const parsedForm = DecisionRequestSchema.safeParse(Object.fromEntries(form));
    if (!parsedForm.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const {
      csrf_token: csrfToken,
      decision,
      client_id: clientId,
      redirect_uri: redirectUri,
      state: stateParam,
    } = parsedForm.data;

    const sessionPayload = await resolveSession(c.req.raw);
    if (!sessionPayload) {
      return c.json({ error: "unauthorized", error_description: "session expired" }, 401);
    }

    const db = c.get("db");
    if (!(await sessionIsLive(db, sessionPayload.session_id, sessionPayload.tenant_id))) {
      return c.json({ error: "unauthorized", error_description: "session revoked" }, 401);
    }

    const csrfSecret = deriveSessionSecret();
    const csrfPayload = await verifyCsrfToken(csrfSecret, csrfToken);
    if (
      !csrfPayload ||
      csrfPayload.session_id !== sessionPayload.session_id ||
      csrfPayload.client_id !== clientId ||
      csrfPayload.redirect_uri !== redirectUri
    ) {
      if ((c.req.header("accept") ?? "").includes("application/json")) {
        return c.json(
          { error: "invalid_request", error_description: "CSRF verification failed" },
          400,
        );
      }
      if (clientId && redirectUri) {
        const staleClient = await createMcpOAuthProvider({
          db,
          config: getConfig(),
        }).getClient(clientId);
        if (staleClient?.redirect_uris.includes(redirectUri)) {
          return buildErrorRedirect(redirectUri, "access_denied", stateParam || null);
        }
      }
      return authHtmlResponse(
        renderErrorPage(SIGN_IN_FAILED_TITLE, STATE_ERROR_MESSAGE, "/v1/identity/login/start"),
        400,
      );
    }

    const state = (csrfPayload.state as string | undefined) ?? stateParam;
    const signedResource = String(csrfPayload.resource ?? "");
    if (parsedForm.data.resource !== signedResource) {
      return c.json({ error: "invalid_request", error_description: "resource mismatch" }, 400);
    }
    const target = oauthResource(getConfig().server.public_base_url, signedResource);
    if (!target) {
      return buildErrorRedirect(redirectUri, "invalid_target", state);
    }
    const resource = target.resource;

    if (!redirectUri || !clientId) {
      return c.json({ error: "invalid_request" }, 400);
    }

    const provider = createMcpOAuthProvider({ db, config: getConfig() });
    const client = await provider.getClient(clientId);
    if (!client?.redirect_uris.includes(redirectUri)) {
      return c.json({ error: "invalid_client" }, 400);
    }

    if (decision === "deny") {
      await auditAwait(
        {
          tenant_id: sessionPayload.tenant_id,
          actor_type: "user",
          actor_id: sessionPayload.user_id,
          action: AuditAction.MCP_OAUTH_CONSENT_DENIED,
          resource_type: "mcp_oauth_client",
          resource_id: clientId,
          result: "denied",
          metadata: {
            request_source: readRequestSource(c),
            client_id: clientId,
            reason: "user_denied",
          },
        },
        db,
      );
      return buildErrorRedirect(redirectUri, "access_denied", state);
    }

    if (decision === "switch_account") {
      await db
        .update(sessions)
        .set({ revoked_at: new Date() })
        .where(
          and(
            eq(sessions.id, sessionPayload.session_id),
            eq(sessions.tenant_id, sessionPayload.tenant_id),
          ),
        );
      await auditAwait(
        {
          tenant_id: sessionPayload.tenant_id,
          actor_type: "user",
          actor_id: sessionPayload.user_id,
          action: AuditAction.SESSION_REVOKED,
          resource_type: "session",
          resource_id: sessionPayload.session_id,
          result: "success",
          reason: "switch_account",
          metadata: { request_source: readRequestSource(c), via: "mcp_oauth_consent" },
        },
        db,
      );
      const authorizeUrl = new URL("/v1/oauth/authorize", provider.getBaseUrl());
      authorizeUrl.searchParams.set("client_id", clientId);
      authorizeUrl.searchParams.set("redirect_uri", redirectUri);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("code_challenge", String(csrfPayload.code_challenge ?? ""));
      authorizeUrl.searchParams.set("code_challenge_method", "S256");
      authorizeUrl.searchParams.set("scope", String(csrfPayload.offered_scopes ?? "mcp:read"));
      if (resource) authorizeUrl.searchParams.set("resource", resource);
      if (state) authorizeUrl.searchParams.set("state", state);
      return new Response(null, {
        status: 302,
        headers: {
          location: authorizeUrl.toString(),
          "set-cookie": "subkit_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
          "cache-control": "no-store",
        },
      });
    }

    const codeChallenge = (csrfPayload.code_challenge as string | undefined) ?? "";
    const ceiling = (csrfPayload.offered_scopes as string | undefined) ?? "";
    const freshUserRows = await db
      .select({ role_name: rolesTable.name })
      .from(users)
      .leftJoin(rolesTable, eq(rolesTable.id, users.role_id))
      .where(
        and(eq(users.id, sessionPayload.user_id), eq(users.tenant_id, sessionPayload.tenant_id)),
      )
      .limit(1);
    const freshRoleRow = freshUserRows[0];
    const freshRole = freshRoleRow?.role_name ?? null;
    const freshRoleScopes =
      target.kind === "cli_login"
        ? [CLI_LOGIN_SCOPE]
        : await permittedMcpScopes(db, sessionPayload.tenant_id, sessionPayload.user_id, freshRole);
    const scope = intersectScopes(
      intersectScopes(selectedScopes.join(" "), ceiling.split(" ").filter(Boolean)),
      freshRoleScopes,
    );
    if (!scope) {
      await auditAwait(
        {
          tenant_id: sessionPayload.tenant_id,
          actor_type: "user",
          actor_id: sessionPayload.user_id,
          action: AuditAction.MCP_OAUTH_CONSENT_DENIED,
          resource_type: "mcp_oauth_client",
          resource_id: clientId,
          result: "denied",
          metadata: {
            request_source: readRequestSource(c),
            client_id: clientId,
            reason: "role_downgrade",
          },
        },
        db,
      );
      return buildErrorRedirect(redirectUri, "access_denied", state);
    }

    try {
      const code = await provider.issueAuthorizationCode({
        clientId,
        tenantId: sessionPayload.tenant_id,
        userId: sessionPayload.user_id,
        redirectUri,
        codeChallenge,
        scope,
        resource: resource || undefined,
        state: state || undefined,
        requestSource: readRequestSource(c) ?? "api",
      });

      await auditAwait(
        {
          tenant_id: sessionPayload.tenant_id,
          actor_type: "user",
          actor_id: sessionPayload.user_id,
          action: AuditAction.MCP_OAUTH_CONSENT_GRANTED,
          resource_type: "mcp_oauth_client",
          resource_id: clientId,
          result: "success",
          metadata: {
            request_source: readRequestSource(c),
            client_id: clientId,
            scope,
          },
        },
        db,
      );

      const url = new URL(redirectUri);
      url.searchParams.set("code", code);
      if (state) url.searchParams.set("state", state);
      return Response.redirect(url.toString(), 302);
    } catch (err) {
      logger.error({
        module: "mcp_oauth",
        action: "consent.issue_code_failed",
        msg: "failed to issue authorization code",
        error: err instanceof Error ? err.message : String(err),
      });
      return buildErrorRedirect(redirectUri, "server_error", state);
    }
  });
}
