// MCP OAuth 2.1 consent flow: GET /v1/oauth/authorize and POST /v1/oauth/authorize/decision.
//
// Raw Hono handlers — not @hono/zod-openapi.
// Precedent: the raw /mcp mount in mcp/transports/streamable-http.ts.

import type { OpenAPIHono } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import {
  AuditAction,
  auditAwait,
  readRequestSource,
  SYSTEM_TENANT_ID,
} from "../../../audit/index.ts";
import { createMcpOAuthProvider } from "../../../auth/index.ts";
import { getConfig } from "../../../config/loader.ts";
import { tenants, users } from "../../../db/schema/index.ts";
import { logger } from "../../../logging/index.ts";
import type { AppEnv } from "../../openapi.ts";
import {
  buildErrorRedirect,
  DecisionRequestSchema,
  deriveSessionSecret,
  intersectScopes,
  parseFormBody,
  permittedMcpScopes,
  renderConsentPage,
  resolveSession,
  sessionIsLive,
  signCsrfToken,
  verifyCsrfToken,
} from "./shared.ts";

export function registerOAuthConsentRoutes(app: OpenAPIHono<AppEnv>): void {
  // ── Authorization endpoint ─────────────────────────────────────────────────
  app.get("/v1/oauth/authorize", async (c) => {
    const qs = c.req.query();
    const clientId = qs.client_id;
    const redirectUri = qs.redirect_uri;
    const responseType = qs.response_type;
    const codeChallenge = qs.code_challenge;
    const codeChallengeMethod = qs.code_challenge_method;
    const scope = qs.scope ?? "mcp:read";
    const resource = qs.resource ?? "";
    const state = qs.state ?? "";

    // Validate required params before any redirect to prevent open-redirect
    if (!clientId || !redirectUri) {
      return c.json(
        { error: "invalid_request", error_description: "client_id and redirect_uri required" },
        400,
      );
    }

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
      return c.json({ error: "invalid_client", error_description: "unknown client_id" }, 400);
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
      return c.json(
        { error: "invalid_request", error_description: "redirect_uri not registered" },
        400,
      );
    }

    if (responseType !== "code") {
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
    if (!sessionPayload) {
      // Not logged in — redirect to OIDC login, then back here
      const authorizeUrl = c.req.url;
      const loginUrl = new URL(`/v1/identity/login/start`, provider.getBaseUrl());
      loginUrl.searchParams.set("redirect_to", authorizeUrl);
      return Response.redirect(loginUrl.toString(), 302);
    }

    // Confirm the session row is still live (not revoked since issue).
    if (!(await sessionIsLive(db, sessionPayload.session_id, sessionPayload.tenant_id))) {
      const loginUrl = new URL(`/v1/identity/login/start`, provider.getBaseUrl());
      loginUrl.searchParams.set("redirect_to", c.req.url);
      return Response.redirect(loginUrl.toString(), 302);
    }

    // Fetch user info for consent page
    const userRows = await db
      .select({ email: users.email, role: users.role })
      .from(users)
      .where(
        and(eq(users.id, sessionPayload.user_id), eq(users.tenant_id, sessionPayload.tenant_id)),
      )
      .limit(1);
    const userRow = userRows[0];
    if (!userRow) {
      return c.json({ error: "server_error" }, 500);
    }

    // Fetch tenant display name
    const tenantRows = await db
      .select({ display_name: tenants.display_name })
      .from(tenants)
      .where(eq(tenants.id, sessionPayload.tenant_id))
      .limit(1);
    const tenantRow = tenantRows[0];

    // Intersect requested scopes with supported scopes
    let supportedScopes: string[] = ["mcp:read", "mcp:authoring", "mcp:admin"];
    try {
      supportedScopes = getConfig().auth.mcp_oauth.scopes_supported;
    } catch {
      /* not yet loaded */
    }
    // Default scope before role intersection — a request with no scope param
    // starts at "mcp:read" before being narrowed by the role check.
    const requestedScope = scope || "mcp:read";
    // A token can never carry a scope its owner's role lacks.
    const roleScopes = await permittedMcpScopes(
      db,
      sessionPayload.tenant_id,
      sessionPayload.user_id,
      userRow.role,
    );
    const grantedScope = intersectScopes(
      intersectScopes(requestedScope, supportedScopes),
      roleScopes,
    );

    // Empty intersection after role-check → access_denied
    if (!grantedScope) {
      return buildErrorRedirect(redirectUri, "access_denied", state);
    }

    const scopeList = grantedScope.split(" ").filter(Boolean);

    // Mint a signed anti-CSRF token bound to the session
    const csrfSecret = deriveSessionSecret();
    const csrfToken = await signCsrfToken(csrfSecret, {
      session_id: sessionPayload.session_id,
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: grantedScope,
      code_challenge: codeChallenge,
      code_challenge_method: codeChallengeMethod,
      resource,
      state,
    });

    const html = renderConsentPage({
      clientName: client.client_name ?? clientId,
      tenantName: tenantRow?.display_name ?? sessionPayload.tenant_id,
      scopes: scopeList,
      csrfToken,
      state,
      clientId,
      redirectUri,
      resource,
    });

    return c.html(html, 200, {
      "X-Frame-Options": "DENY",
      // Lock the consent page down: no scripts/images/fetch of any kind,
      // inline <style> only, form POST restricted to same-origin. Defence
      // in depth behind the escapeHtml() of every interpolated value.
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      "Cache-Control": "no-store",
    });
  });

  // ── Consent decision ─────────────────────────────────────────────────────
  // Raw handler — form-encoded body
  app.post("/v1/oauth/authorize/decision", async (c) => {
    const parsedForm = DecisionRequestSchema.safeParse(
      Object.fromEntries(await parseFormBody(c.req.raw)),
    );
    if (!parsedForm.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const {
      csrf_token: csrfToken,
      decision,
      client_id: clientId,
      redirect_uri: redirectUri,
      resource,
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
      return c.json(
        { error: "invalid_request", error_description: "CSRF verification failed" },
        400,
      );
    }

    const state = (csrfPayload.state as string | undefined) ?? stateParam;

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

    const codeChallenge = (csrfPayload.code_challenge as string | undefined) ?? "";
    // csrfPayload.scope was computed at consent-render time (role intersection).
    // Re-fetch the user's current role and re-run the intersection so a
    // role downgrade between consent render and decision is honored.
    const csrfScope = (csrfPayload.scope as string | undefined) ?? "";
    const freshUserRows = await db
      .select({ role: users.role })
      .from(users)
      .where(
        and(eq(users.id, sessionPayload.user_id), eq(users.tenant_id, sessionPayload.tenant_id)),
      )
      .limit(1);
    const freshRole = freshUserRows[0]?.role ?? "enduser";
    const freshRoleScopes = await permittedMcpScopes(
      db,
      sessionPayload.tenant_id,
      sessionPayload.user_id,
      freshRole,
    );
    // Re-intersect the baked scope against the current role permissions so a
    // role downgrade between consent render and decision is honored. NO
    // fallback to the stale csrfScope — if the downgrade leaves an empty
    // intersection the user no longer holds any consented scope, so the
    // grant must be denied rather than minted at the pre-downgrade level.
    const scope = intersectScopes(csrfScope, freshRoleScopes);
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
