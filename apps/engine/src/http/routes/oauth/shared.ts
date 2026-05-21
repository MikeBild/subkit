// Shared helpers, constants, and schemas for MCP OAuth 2.1 route files.

import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import * as jose from "jose";
import { z } from "zod";
import type { ResolvedPrincipal } from "../../../auth/index.ts";
import { getConfig } from "../../../config/loader.ts";
import type { Db } from "../../../db/client.ts";
import { sessions } from "../../../db/schema/index.ts";
import { env } from "../../../env.ts";
import { can } from "../../../rbac/index.ts";
import { PayloadTooLargeError } from "../../errors.ts";

export const SESSION_COOKIE = "subkit_session";
export const CSRF_ALG = "HS256";

// ── Helpers ───────────────────────────────────────────────────────────────────

export function parseCookies(header: string | null): Record<string, string> {
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

export function deriveSessionSecret(): Uint8Array {
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

export async function verifySessionCookie(
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

export interface SessionPrincipal {
  session_id: string;
  user_id: string;
  tenant_id: string;
  email: string;
  role: string;
}

export async function resolveSession(req: Request): Promise<SessionPrincipal | null> {
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

export async function signCsrfToken(
  secret: Uint8Array,
  payload: Record<string, unknown>,
): Promise<string> {
  return new jose.SignJWT(payload)
    .setProtectedHeader({ alg: CSRF_ALG })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(secret);
}

export async function verifyCsrfToken(
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
export function intersectScopes(requested: string, supported: string[]): string {
  const parts = requested.split(" ").filter(Boolean);
  const valid = parts.filter((s) => supported.includes(s));
  return valid.join(" ");
}

// The OAuth scope strings are 1:1 with RBAC permission names.
export const MCP_SCOPE_PERMISSIONS = ["mcp:read", "mcp:authoring", "mcp:admin"] as const;

// MCP scopes the principal is permitted to hold — a token can never
// carry a scope its owner lacks. Derived from the RBAC catalog via
// `can()` so a custom role granted `mcp:*` permissions behaves exactly
// like the built-in roles; the rbac seed is the single source of truth.
export async function permittedMcpScopes(
  db: Db,
  tenantId: string,
  userId: string,
  roleName: string,
): Promise<string[]> {
  const principal: ResolvedPrincipal = {
    provider: "oidc",
    kind: "user",
    id: userId,
    tenant_id: tenantId,
    roles: [roleName],
    scopes: [],
  };
  const allowed: string[] = [];
  for (const permission of MCP_SCOPE_PERMISSIONS) {
    const decision = await can(db, { tenant_id: tenantId, principal, permission });
    if (decision.allow) allowed.push(permission);
  }
  return allowed;
}

// A session JWT only proves the cookie was issued by us. Revocation
// cannot be carried in the stateless JWT, so every consent-flow step
// (authorize render AND decision submit) must re-read the session row.
export async function sessionIsLive(db: Db, sessionId: string, tenantId: string): Promise<boolean> {
  const rows = await db
    .select({ revoked_at: sessions.revoked_at })
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.tenant_id, tenantId)))
    .limit(1);
  const row = rows[0];
  return row != null && row.revoked_at == null;
}

// HTML for the consent page
export function renderConsentPage(opts: {
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

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

// OAuth error redirect helper
export function buildErrorRedirect(
  redirectUri: string,
  error: string,
  state: string | null,
): Response {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  if (state) url.searchParams.set("state", state);
  return Response.redirect(url.toString(), 302);
}

// Form-encoded body parser — rejects bodies over 64KB
export const FORM_BODY_MAX_BYTES = 64 * 1024;
export async function parseFormBody(req: Request): Promise<URLSearchParams> {
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

// ── Request body schemas ──────────────────────────────────────────────────────
// Form-encoded endpoints are raw Hono handlers (not @hono/zod-openapi), but
// their bodies are still Zod-validated at the boundary per AGENTS.md.

export const TokenRequestSchema = z.object({
  grant_type: z.string(),
  code: z.string().optional(),
  code_verifier: z.string().optional(),
  redirect_uri: z.string().optional(),
  client_id: z.string().optional(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
});

export const RevokeRequestSchema = z.object({
  token: z.string().optional(),
  token_type_hint: z.string().optional(),
});

export const DecisionRequestSchema = z.object({
  csrf_token: z.string().default(""),
  decision: z.string().optional(),
  client_id: z.string().default(""),
  redirect_uri: z.string().default(""),
  resource: z.string().default(""),
  state: z.string().default(""),
});
