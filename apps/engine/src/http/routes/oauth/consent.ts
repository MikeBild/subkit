// MCP OAuth 2.1 consent flow: GET /v1/oauth/authorize and POST /v1/oauth/authorize/decision.
//
// Raw Hono handlers — not @hono/zod-openapi.
// Precedent: the raw /mcp mount in mcp/transports/streamable-http.ts.

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
  authHtmlResponse,
  AUTHORIZE_INVALID_MESSAGE,
  renderConsentPage,
  renderErrorPage,
  resolveAuthLocale,
  SIGN_IN_FAILED_TITLE,
  STATE_ERROR_MESSAGE,
} from "./ui.ts";

// Authorize-endpoint failures that must NOT redirect to the (unvalidated)
// client render the shared HTML error page for browsers; JSON stays reserved
// for clients that explicitly Accept: application/json.
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
  // ── Authorization endpoint ─────────────────────────────────────────────────
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

    // Exact redirect_uri match — open-redirect critical guard
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

    // Only redirect OAuth errors after the callback URI has passed the exact
    // registration check above. Doing this earlier would turn an otherwise
    // harmless invalid resource indicator into an open redirect.
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

    // Check session cookie
    const sessionPayload = await resolveSession(c.req.raw);
    // The engine sits behind a TLS-terminating proxy, so `c.req.url` is the
    // internal http:// URL. Rebuild redirect_to against the external base so
    // the post-login isSafeRedirect (same-origin) check accepts it and the
    // funnel resumes at /v1/oauth/authorize instead of falling back to "/".
    const externalAuthorizeUrl = (() => {
      const u = new URL(c.req.url);
      const base = new URL(provider.getBaseUrl());
      u.protocol = base.protocol;
      u.host = base.host;
      return u.toString();
    })();
    if (!sessionPayload) {
      // Not logged in — hand the provider-neutral login funnel one opaque
      // state, just like the other product runtimes. Provider selection never
      // receives or exposes the nested authorization URL.
      const loginUrl = new URL(`/v1/identity/login/start`, provider.getBaseUrl());
      loginUrl.searchParams.set(
        "login_state",
        await signLoginState({ redirect_to: externalAuthorizeUrl }),
      );
      return Response.redirect(loginUrl.toString(), 302);
    }

    // Confirm the session row is still live (not revoked since issue).
    if (!(await sessionIsLive(db, sessionPayload.session_id, sessionPayload.tenant_id))) {
      const loginUrl = new URL(`/v1/identity/login/start`, provider.getBaseUrl());
      loginUrl.searchParams.set(
        "login_state",
        await signLoginState({ redirect_to: externalAuthorizeUrl }),
      );
      return Response.redirect(loginUrl.toString(), 302);
    }

    // Fetch user info for the consent page — ACTIVE users only.
    //
    // Login re-checks `status`/`deleted_at`, but a session issued before the
    // account was disabled never passes back through login, so without these two
    // predicates a deactivated account still walked an authorization to a code
    // off its existing cookie. (`deactivateUser` now revokes sessions as well;
    // this is the second, independent guard, so neither alone has to be perfect.)
    const userRows = await db
      .select({ email: users.email, role: users.role, role_name: rolesTable.name })
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
      // Not a server fault: the session is real, the account is not entitled any
      // more. Deny like every other authorization refusal — and audibly, because
      // a silent denial here is indistinguishable from an outage.
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

    // Fetch tenant display name
    const tenantRows = await db
      .select({ display_name: tenants.display_name })
      .from(tenants)
      .where(eq(tenants.id, sessionPayload.tenant_id))
      .limit(1);
    const tenantRow = tenantRows[0];

    // Intersect requested scopes with supported scopes
    let supportedScopes: string[] =
      target.kind === "cli_login" ? [CLI_LOGIN_SCOPE] : [...MCP_SCOPE_PERMISSIONS];
    if (target.kind === "mcp") {
      try {
        supportedScopes = getConfig().auth.mcp_oauth.scopes_supported;
      } catch {
        /* not yet loaded */
      }
    }
    // RFC 6749 §3.3 — a request with no scope param falls back to the client's
    // REGISTERED scope set, not a hard "mcp:read": scope-less clients (ChatGPT
    // omits the param entirely) can then still be OFFERED authoring/admin.
    // Offering is not granting — the role intersection below and the consent
    // checkboxes remain the gate, and mcp:read stays the only pre-checked box.
    const registeredScope =
      client.scope || (target.kind === "cli_login" ? CLI_LOGIN_SCOPE : "mcp:read");
    const requestedScope = scopeParam ?? registeredScope;
    // A token can never carry a scope its owner's role lacks.
    // Prefer the custom-role name from the roles table; fall back to the
    // legacy enum column so built-in roles without a roles row still resolve.
    const roleScopes =
      target.kind === "cli_login"
        ? [CLI_LOGIN_SCOPE]
        : await permittedMcpScopes(
            db,
            sessionPayload.tenant_id,
            sessionPayload.user_id,
            userRow.role_name ?? userRow.role,
          );
    // A consent screen may only offer scopes the client actually requested.
    // Clamp request ∩ supported ∩ current role, in stable presentation order.
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

    // Pre-check what the client asked for (clamped to the offered ceiling), and
    // always pre-check mcp:read when offered — it is the granted baseline.
    //
    // `metrics:read` is the exception: a scope-less DCR client registers the
    // FULL supported set, so the RFC 6749 fallback above would otherwise
    // pre-tick "read the operational counters" for a client that never asked
    // for it. It is offered — an unchecked box the person can tick — but only
    // an explicit `scope=` parameter pre-ticks it.
    const requestedSet = new Set(requestedScope.split(" ").filter(Boolean));
    const explicitlyRequested = new Set((scopeParam ?? "").split(" ").filter(Boolean));
    const preChecked = offeredScopes.filter((s) =>
      s === METRICS_SCOPE ? explicitlyRequested.has(s) : requestedSet.has(s) || s === "mcp:read",
    );

    // Never silently add an unrequested scope, and never render a consent
    // screen with nothing on it.
    //
    // This is the entitlement gate: an account whose role holds none of the
    // offerable permissions cannot be offered anything, so it is denied here.
    // It used to deny SILENTLY — no audit row, no log — which is why an
    // unentitled account reaching this screen could only be detected by
    // scraping the HTML.
    //
    // The gate used to demand `mcp:read` specifically, which made a
    // monitoring-only connection impossible: a client asking for
    // `scope=metrics:read` was offered exactly that and then refused for not
    // having asked for MCP read as well. Any non-empty offer is a valid
    // consent screen.
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
            role: userRow.role_name ?? userRow.role,
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
        role: userRow.role_name ?? userRow.role,
      });
      return buildErrorRedirect(redirectUri, "access_denied", state);
    }

    // Mint a signed anti-CSRF token bound to the session. Bake the offered
    // CEILING (not the client request): at decision time the granted scope is
    // clamped to selected ∩ offered_scopes ∩ fresh-role ∩ supported.
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

  // ── Consent decision ─────────────────────────────────────────────────────
  // Raw handler — form-encoded body
  app.post("/v1/oauth/authorize/decision", async (c) => {
    const form = await parseFormBody(c.req.raw);
    // The consent form posts one `scope` field per selected checkbox. Read the
    // authoritative multi-value list from the raw params — Object.fromEntries
    // would collapse repeated fields to the last value and silently drop the
    // operator's other selections.
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

    // Re-verify session
    const sessionPayload = await resolveSession(c.req.raw);
    if (!sessionPayload) {
      return c.json({ error: "unauthorized", error_description: "session expired" }, 401);
    }

    // Honour a session revoked between consent render and this submit —
    // the 5-minute CSRF-token window otherwise leaves it exploitable.
    const db = c.get("db");
    if (!(await sessionIsLive(db, sessionPayload.session_id, sessionPayload.tenant_id))) {
      return c.json({ error: "unauthorized", error_description: "session revoked" }, 401);
    }

    // Verify anti-CSRF token
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
      // Typical browser cause: the consent page sat open past the 5-minute
      // CSRF window. When the waiting OAuth client is validated-known,
      // complete the RFC 6749 dance with error=access_denied so MCP clients
      // do not hang; otherwise render the shared HTML error page.
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
    // Normalize legacy signed consent pages (empty/base resource) to the exact
    // MCP audience at code issuance. The form still has to match the signed
    // value byte-for-byte, so this compatibility path cannot be tampered with.
    const resource = target.resource;

    if (!redirectUri || !clientId) {
      return c.json({ error: "invalid_request" }, 400);
    }

    // Re-validate redirect_uri against registered URIs (replay protection)
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
    // The CSRF token bakes the offered CEILING (the role-permitted scopes shown
    // on the consent page), NOT the final grant. The grant is whatever the
    // operator selected, clamped to that ceiling AND re-clamped to the fresh
    // role so a downgrade between consent render and decision is honored.
    const ceiling = (csrfPayload.offered_scopes as string | undefined) ?? "";
    const freshUserRows = await db
      .select({ role: users.role, role_name: rolesTable.name })
      .from(users)
      .leftJoin(rolesTable, eq(rolesTable.id, users.role_id))
      .where(
        and(eq(users.id, sessionPayload.user_id), eq(users.tenant_id, sessionPayload.tenant_id)),
      )
      .limit(1);
    const freshRoleRow = freshUserRows[0];
    // Prefer the custom-role name from the roles table; fall back to the
    // legacy enum column so built-in roles without a roles row still resolve.
    const freshRole = freshRoleRow?.role_name ?? freshRoleRow?.role ?? "enduser";
    const freshRoleScopes =
      target.kind === "cli_login"
        ? [CLI_LOGIN_SCOPE]
        : await permittedMcpScopes(db, sessionPayload.tenant_id, sessionPayload.user_id, freshRole);
    // Clamp the operator's selection by BOTH the baked ceiling and the fresh
    // role permissions. A tampered form that posts a scope the role lacks (or
    // that was never offered) is intersected away; an empty result denies. The
    // ceiling itself is already supported∩role from render time, so role is the
    // hard ceiling and offered_scopes is a stable upper bound.
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
