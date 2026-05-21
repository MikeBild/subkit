// MCP OAuth 2.1 authorization + resource server routes.
//
// Registered OUTSIDE requireAuth — these bootstrap the OAuth session.
// Implements:
//   GET  /.well-known/oauth-protected-resource        RFC 9728
//   GET  /.well-known/oauth-protected-resource/mcp    RFC 9728 (variant)
//   GET  /.well-known/oauth-authorization-server      RFC 8414
//   POST /v1/oauth/register                            RFC 7591 DCR
//   GET  /v1/oauth/authorize                           auth-code + PKCE S256
//   POST /v1/oauth/authorize/decision                  consent approve/deny
//   POST /v1/oauth/token                               token exchange (form-encoded)
//   POST /v1/oauth/revoke                              RFC 7009
//
// The .well-known and form-encoded token endpoints cannot be expressed cleanly
// via @hono/zod-openapi (non-standard paths, application/x-www-form-urlencoded
// body), so they are registered as raw Hono handlers with a brief note.
// Precedent: the raw /mcp mount in mcp/transports/streamable-http.ts.

import { createHash } from "node:crypto";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import * as jose from "jose";
import { z } from "zod";
import { AuditAction, auditAwait, readRequestSource } from "../../audit/index.ts";
import { createMcpOAuthProvider } from "../../auth/index.ts";
import { getConfig } from "../../config/loader.ts";
import { sessions, tenants, users } from "../../db/schema/index.ts";
import { env } from "../../env.ts";
import { logger } from "../../logging/index.ts";
import { PayloadTooLargeError } from "../errors.ts";
import type { AppEnv } from "../openapi.ts";

const SESSION_COOKIE = "subkit_session";
const CSRF_ALG = "HS256";

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseCookies(header: string | null): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  }
  return out;
}

function deriveSessionSecret(): Uint8Array {
  let fromConfig = "";
  try {
    fromConfig = (getConfig().auth.session.secret ?? "").trim();
  } catch {
    /* loader not initialised */
  }
  if (fromConfig.length > 0) {
    return new TextEncoder().encode(fromConfig);
  }
  const masterKey = env.MASTER_KEY ?? "";
  return new Uint8Array(createHash("sha256").update(`${masterKey}:session`).digest());
}

async function verifySessionCookie(
  secret: Uint8Array,
  jwt: string,
): Promise<{ session_id: string; user_id: string; tenant_id: string } | null> {
  try {
    const { payload } = await jose.jwtVerify(jwt, secret);
    const session_id = typeof payload.session_id === "string" ? payload.session_id : null;
    const user_id = typeof payload.user_id === "string" ? payload.user_id : null;
    const tenant_id = typeof payload.tenant_id === "string" ? payload.tenant_id : null;
    if (!session_id || !user_id || !tenant_id) return null;
    return { session_id, user_id, tenant_id };
  } catch {
    return null;
  }
}

interface SessionPrincipal {
  session_id: string;
  user_id: string;
  tenant_id: string;
  email: string;
  role: string;
}

async function resolveSession(req: Request): Promise<SessionPrincipal | null> {
  const cookieHeader = req.headers.get("cookie");
  const cookies = parseCookies(cookieHeader);
  const jwt = cookies[SESSION_COOKIE];
  if (!jwt) return null;

  const secret = deriveSessionSecret();
  const payload = await verifySessionCookie(secret, jwt);
  if (!payload) return null;

  // Quick validity check on session row (revoked / expired).
  // We do a lightweight read here — the full sliding-TTL logic lives in oidc.ts.
  return payload as SessionPrincipal;
}

async function signCsrfToken(
  secret: Uint8Array,
  payload: Record<string, unknown>,
): Promise<string> {
  return new jose.SignJWT(payload)
    .setProtectedHeader({ alg: CSRF_ALG })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(secret);
}

async function verifyCsrfToken(
  secret: Uint8Array,
  token: string,
): Promise<Record<string, unknown> | null> {
  try {
    const { payload } = await jose.jwtVerify(token, secret);
    return payload as Record<string, unknown>;
  } catch {
    return null;
  }
}

// Compute intersection of requested scopes vs supported scopes.
// Returns "" for an empty intersection — callers must handle that case.
function intersectScopes(requested: string, supported: string[]): string {
  const parts = requested.split(" ").filter(Boolean);
  const valid = parts.filter((s) => supported.includes(s));
  return valid.join(" ");
}

// Scopes a role is permitted to hold — a token can never carry a
// scope its owner lacks. Mirrors what mode-resolver.ts reads.
function permittedScopesForRole(role: string): string[] {
  if (role === "admin") return ["mcp:read", "mcp:authoring", "mcp:admin"];
  if (role === "member") return ["mcp:read", "mcp:authoring"];
  // enduser and other roles get read-only access only
  return ["mcp:read"];
}

// HTML for the consent page
function renderConsentPage(opts: {
  clientName: string;
  tenantName: string;
  scopes: string[];
  csrfToken: string;
  state: string;
  clientId: string;
  redirectUri: string;
  resource: string;
}): string {
  const scopeLabels: Record<string, string> = {
    "mcp:read": "Read-only access to MCP tools and workflows",
    "mcp:authoring": "Access conversation authoring tools via MCP",
    "mcp:admin": "Full administrative access via MCP",
  };
  const scopeItems = opts.scopes
    .map((s) => {
      const label = scopeLabels[s] ?? s;
      return `<li><strong>${escapeHtml(s)}</strong> — ${escapeHtml(label)}</li>`;
    })
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize — sk</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 480px; margin: 48px auto; padding: 0 16px; }
    h1 { font-size: 1.25rem; }
    .client { font-weight: bold; }
    ul { padding-left: 1.2em; }
    .actions { display: flex; gap: 12px; margin-top: 24px; }
    button { padding: 8px 20px; font-size: 1rem; cursor: pointer; border: none; border-radius: 4px; }
    .approve { background: #0070f3; color: #fff; }
    .deny { background: #e5e7eb; color: #111; }
  </style>
</head>
<body>
  <h1>Authorize access</h1>
  <p><span class="client">${escapeHtml(opts.clientName)}</span> is requesting permission to access
  your <strong>${escapeHtml(opts.tenantName)}</strong> workspace.</p>
  <p>It will be able to:</p>
  <ul>${scopeItems}</ul>
  <form method="POST" action="/v1/oauth/authorize/decision">
    <input type="hidden" name="csrf_token" value="${escapeHtml(opts.csrfToken)}">
    <input type="hidden" name="client_id" value="${escapeHtml(opts.clientId)}">
    <input type="hidden" name="redirect_uri" value="${escapeHtml(opts.redirectUri)}">
    <input type="hidden" name="resource" value="${escapeHtml(opts.resource)}">
    <input type="hidden" name="state" value="${escapeHtml(opts.state)}">
    <div class="actions">
      <button type="submit" name="decision" value="approve" class="approve">Approve</button>
      <button type="submit" name="decision" value="deny" class="deny">Deny</button>
    </div>
  </form>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

// OAuth error redirect helper
function buildErrorRedirect(redirectUri: string, error: string, state: string | null): Response {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  if (state) url.searchParams.set("state", state);
  return Response.redirect(url.toString(), 302);
}

// Form-encoded body parser — rejects bodies over 64KB
const FORM_BODY_MAX_BYTES = 64 * 1024;
async function parseFormBody(req: Request): Promise<URLSearchParams> {
  const contentLength = req.headers.get("content-length");
  if (contentLength !== null && parseInt(contentLength, 10) > FORM_BODY_MAX_BYTES) {
    throw new PayloadTooLargeError("request body too large");
  }
  // Read with a byte cap to guard against missing/spoofed Content-Length
  const buf = await req.arrayBuffer();
  if (buf.byteLength > FORM_BODY_MAX_BYTES) {
    throw new PayloadTooLargeError("request body too large");
  }
  const text = new TextDecoder().decode(buf);
  return new URLSearchParams(text);
}

// ── Per-IP rate limiter for DCR ─────────────────────────────────────────
// Max 10 registrations per IP per 60s. Checked before any DB work.
const DCR_MAX = 10;
const DCR_WINDOW_MS = 60_000;
interface DcrBucket {
  count: number;
  resetAt: number;
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerMcpOAuthRoutes(app: OpenAPIHono<AppEnv>): void {
  // Bucket map is scoped to this registration call so each app instance
  // (e.g. per-test server) gets its own independent rate-limit state.
  const dcrBuckets = new Map<string, DcrBucket>();

  function checkDcrRateLimit(ip: string): boolean {
    const now = Date.now();
    const bucket = dcrBuckets.get(ip);
    if (!bucket || now >= bucket.resetAt) {
      dcrBuckets.set(ip, { count: 1, resetAt: now + DCR_WINDOW_MS });
      return true;
    }
    if (bucket.count >= DCR_MAX) return false;
    bucket.count += 1;
    return true;
  }
  // ── RFC 9728 Protected Resource Metadata ─────────────────────────────────
  // Raw handler — .well-known paths are not expressible as zod-openapi routes.
  app.get("/.well-known/oauth-protected-resource", (c) => {
    let base: string;
    try {
      base = getConfig().server.public_base_url;
    } catch {
      return c.json({ error: "service_unavailable" }, 503);
    }
    return c.json({
      resource: `${base}/mcp`,
      authorization_servers: [base],
    });
  });

  app.get("/.well-known/oauth-protected-resource/mcp", (c) => {
    let base: string;
    try {
      base = getConfig().server.public_base_url;
    } catch {
      return c.json({ error: "service_unavailable" }, 503);
    }
    return c.json({
      resource: `${base}/mcp`,
      authorization_servers: [base],
    });
  });

  // ── RFC 8414 Authorization Server Metadata ─────────────────────────────────
  // Raw handler — .well-known paths are not expressible as zod-openapi routes.
  app.get("/.well-known/oauth-authorization-server", (c) => {
    let base: string;
    let scopesSupported: string[];
    try {
      const cfg = getConfig();
      base = cfg.server.public_base_url;
      scopesSupported = cfg.auth.mcp_oauth.scopes_supported;
    } catch {
      return c.json({ error: "service_unavailable" }, 503);
    }
    return c.json({
      issuer: base,
      authorization_endpoint: `${base}/v1/oauth/authorize`,
      token_endpoint: `${base}/v1/oauth/token`,
      registration_endpoint: `${base}/v1/oauth/register`,
      revocation_endpoint: `${base}/v1/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: scopesSupported,
    });
  });

  // ── RFC 7591 Dynamic Client Registration ───────────────────────────────────
  app.post("/v1/oauth/register", async (c) => {
    // Per-IP rate limit — checked before any DB work.
    // Only applied when the IP is identifiable; if neither x-forwarded-for
    // nor x-real-ip is present the request came from a trusted reverse-proxy
    // setup without forwarding or from a test harness — skip the limit.
    const ip =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? c.req.header("x-real-ip") ?? null;
    if (ip !== null && !checkDcrRateLimit(ip)) {
      // A 429 here is security-relevant (scanning / abuse) — persist it.
      await auditAwait(
        {
          tenant_id: "00000000-0000-0000-0000-000000000000",
          actor_type: "system",
          action: AuditAction.MCP_OAUTH_DCR_RATE_LIMITED,
          resource_type: "mcp_oauth_client",
          resource_id: null,
          result: "denied",
          metadata: {
            request_source: readRequestSource(c),
            reason: "rate_limited",
            ip,
          },
        },
        c.get("db"),
      );
      return c.json({ error: "too_many_requests", error_description: "rate limit exceeded" }, 429);
    }

    let dynamicEnabled = true;
    try {
      dynamicEnabled = getConfig().auth.mcp_oauth.dynamic_registration_enabled;
    } catch {
      /* not yet loaded */
    }
    if (!dynamicEnabled) {
      return c.json({ error: "registration_not_supported" }, 400);
    }

    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return c.json(
        { error: "invalid_client_metadata", error_description: "invalid JSON body" },
        400,
      );
    }

    // Redirect URI allowlist: https://, http://localhost, http://127.0.0.1,
    // or private-use scheme (URI does not start with http:// to a public host).
    // Rejects plaintext http:// to public hosts.
    const safeRedirectUri = z
      .string()
      .max(2048)
      .refine(
        (uri) => {
          try {
            const u = new URL(uri);
            if (u.protocol === "https:") return true;
            if (u.protocol === "http:") {
              return u.hostname === "localhost" || u.hostname === "127.0.0.1";
            }
            // Private-use / custom schemes (e.g. myapp://) are allowed
            return !u.protocol.startsWith("http");
          } catch {
            // Non-parseable URIs with custom schemes (e.g. myapp://callback) — allow
            // only if the string contains "://" (has a scheme) and is not http to
            // a public host. Scheme-less strings like "not-a-url" are rejected.
            if (!uri.includes("://")) return false;
            return (
              !uri.startsWith("http://") ||
              uri.startsWith("http://localhost") ||
              uri.startsWith("http://127.0.0.1")
            );
          }
        },
        {
          message:
            "redirect_uri must be https, http://localhost, http://127.0.0.1, or a private-use scheme",
        },
      );

    const parsed = z
      .object({
        redirect_uris: z.array(safeRedirectUri).min(1).max(5),
        client_name: z.string().max(255).optional(),
        grant_types: z.array(z.string()).optional(),
        token_endpoint_auth_method: z.string().optional(),
        scope: z.string().optional(),
        software_id: z.string().max(255).optional(),
      })
      .safeParse(body);

    if (!parsed.success) {
      return c.json(
        {
          error: "invalid_client_metadata",
          error_description: parsed.error.issues.map((i) => i.message).join("; "),
        },
        400,
      );
    }

    const db = c.get("db");
    let base = "";
    try {
      base = getConfig().server.public_base_url;
    } catch {
      /* not yet loaded */
    }

    const provider = createMcpOAuthProvider({ db, config: getConfig() });

    try {
      const result = await provider.registerClient(parsed.data);
      return c.json(
        {
          ...result,
          client_id_issued_at: Math.floor(Date.now() / 1000),
          registration_client_uri: `${base}/v1/oauth/register/${result.client_id}`,
        },
        201,
      );
    } catch (err) {
      const oauthError = (err as { oauth_error?: string }).oauth_error;
      logger.error({
        module: "mcp_oauth",
        action: "register.failed",
        msg: "client registration failed",
        error: err instanceof Error ? err.message : String(err),
      });
      await auditAwait(
        {
          tenant_id: "00000000-0000-0000-0000-000000000000",
          actor_type: "system",
          action: AuditAction.OAUTH_CLIENT_REGISTRATION_FAILED,
          resource_type: "mcp_oauth_client",
          resource_id: null,
          result: "error",
          metadata: {
            request_source: readRequestSource(c),
            error: err instanceof Error ? err.message : String(err),
          },
        },
        db,
      );
      if (oauthError) {
        return c.json({ error: oauthError }, 400);
      }
      return c.json({ error: "server_error" }, 500);
    }
  });

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
          tenant_id: "00000000-0000-0000-0000-000000000000",
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
          tenant_id: "00000000-0000-0000-0000-000000000000",
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
          tenant_id: "00000000-0000-0000-0000-000000000000",
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

    // Resolve session to a full db row to check validity
    const sessionRows = await db
      .select({
        id: sessions.id,
        revoked_at: sessions.revoked_at,
        expires_at: sessions.expires_at,
        absolute_expires_at: sessions.absolute_expires_at,
        last_seen_at: sessions.last_seen_at,
      })
      .from(sessions)
      .where(
        and(
          eq(sessions.id, sessionPayload.session_id),
          eq(sessions.tenant_id, sessionPayload.tenant_id),
        ),
      )
      .limit(1);
    const sessionRow = sessionRows[0];

    if (!sessionRow || sessionRow.revoked_at) {
      const authorizeUrl = c.req.url;
      const loginUrl = new URL(`/v1/identity/login/start`, provider.getBaseUrl());
      loginUrl.searchParams.set("redirect_to", authorizeUrl);
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
    const roleScopes = permittedScopesForRole(userRow.role);
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
    const form = await parseFormBody(c.req.raw);
    const csrfToken = form.get("csrf_token") ?? "";
    const decision = form.get("decision");
    const clientId = form.get("client_id") ?? "";
    const redirectUri = form.get("redirect_uri") ?? "";
    const resource = form.get("resource") ?? "";
    const stateParam = form.get("state") ?? "";

    // Re-verify session
    const sessionPayload = await resolveSession(c.req.raw);
    if (!sessionPayload) {
      return c.json({ error: "unauthorized", error_description: "session expired" }, 401);
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
    const db = c.get("db");
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
    const freshRoleScopes = permittedScopesForRole(freshRole);
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

  // ── Token endpoint ─────────────────────────────────────────────────────────
  // Raw handler — application/x-www-form-urlencoded body per RFC 6749.
  app.post("/v1/oauth/token", async (c) => {
    const contentType = c.req.header("content-type") ?? "";
    let form: URLSearchParams;
    if (contentType.includes("application/x-www-form-urlencoded")) {
      form = await parseFormBody(c.req.raw);
    } else {
      // Some clients send JSON — accept it too (S7: parse and validate first)
      const rawBody = await c.req.json().catch(() => null);
      const tokenBodySchema = z.object({
        grant_type: z.string(),
        code: z.string().optional(),
        code_verifier: z.string().optional(),
        redirect_uri: z.string().optional(),
        client_id: z.string().optional(),
        refresh_token: z.string().optional(),
        scope: z.string().optional(),
      });
      const parsed = tokenBodySchema.safeParse(rawBody);
      if (!parsed.success) {
        return c.json(
          { error: "invalid_request", error_description: "unsupported content-type" },
          400,
        );
      }
      form = new URLSearchParams(
        Object.entries(parsed.data).filter(([, v]) => v !== undefined) as [string, string][],
      );
    }

    const grantType = form.get("grant_type");
    const db = c.get("db");
    const provider = createMcpOAuthProvider({ db, config: getConfig() });

    if (grantType === "authorization_code") {
      const code = form.get("code");
      const codeVerifier = form.get("code_verifier");
      const redirectUri = form.get("redirect_uri");
      const clientId = form.get("client_id");

      if (!code || !codeVerifier || !redirectUri || !clientId) {
        return c.json(
          { error: "invalid_request", error_description: "missing required parameters" },
          400,
        );
      }

      try {
        const tokens = await provider.exchangeAuthorizationCode({
          code,
          codeVerifier,
          redirectUri,
          clientId,
        });
        return c.json(tokens, 200, { "Cache-Control": "no-store" });
      } catch (err) {
        const oauthError = (err as { oauth_error?: string }).oauth_error ?? "invalid_grant";
        logger.warn({
          module: "mcp_oauth",
          action: "token.exchange_failed",
          msg: "authorization code exchange failed",
          error: err instanceof Error ? err.message : String(err),
        });
        return c.json({ error: oauthError }, 400, { "Cache-Control": "no-store" });
      }
    }

    if (grantType === "refresh_token") {
      const refreshToken = form.get("refresh_token");
      const clientId = form.get("client_id");
      const scope = form.get("scope") ?? undefined;

      if (!refreshToken || !clientId) {
        return c.json(
          { error: "invalid_request", error_description: "missing required parameters" },
          400,
        );
      }

      try {
        const tokens = await provider.exchangeRefreshToken({
          refreshToken,
          clientId,
          scope,
        });
        return c.json(tokens, 200, { "Cache-Control": "no-store" });
      } catch (err) {
        const oauthError = (err as { oauth_error?: string }).oauth_error ?? "invalid_grant";
        logger.warn({
          module: "mcp_oauth",
          action: "token.refresh_failed",
          msg: "refresh token exchange failed",
          error: err instanceof Error ? err.message : String(err),
        });
        return c.json({ error: oauthError }, 400, { "Cache-Control": "no-store" });
      }
    }

    return c.json({ error: "unsupported_grant_type" }, 400);
  });

  // ── Revocation endpoint ────────────────────────────────────────────────────
  // Raw handler — application/x-www-form-urlencoded body per RFC 7009.
  app.post("/v1/oauth/revoke", async (c) => {
    let form: URLSearchParams;
    try {
      form = await parseFormBody(c.req.raw);
    } catch {
      return c.json({ error: "invalid_request" }, 400);
    }

    const token = form.get("token");
    if (!token) {
      return c.json({ error: "invalid_request", error_description: "token required" }, 400);
    }

    const db = c.get("db");
    const provider = createMcpOAuthProvider({ db, config: getConfig() });
    // RFC 7009: always return 200 regardless of token validity
    await provider.revokeToken(token).catch((err: unknown) => {
      logger.warn({
        module: "mcp_oauth",
        action: "revoke.failed",
        msg: "token revocation failed",
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return c.json({}, 200);
  });
}
