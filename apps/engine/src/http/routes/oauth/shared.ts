import { createHash } from "node:crypto";
import * as jose from "jose";
import { z } from "zod";
import {
  browserSessionFromRequest,
  type ResolvedPrincipal,
  touchSessionIfLive,
} from "../../../auth/index.ts";
import { getConfig } from "../../../config/loader.ts";
import type { Db } from "../../../db/client.ts";
import { env } from "../../../env.ts";
import { can } from "../../../rbac/index.ts";
import { PayloadTooLargeError } from "../../errors.ts";

export const SESSION_COOKIE = "subkit_session";
export const CSRF_ALG = "HS256";

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
  } catch {}
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
  installation_id?: string;
}

export async function resolveSession(req: Request): Promise<SessionPrincipal | null> {
  return await browserSessionFromRequest(req);
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

export function intersectScopes(requested: string, supported: string[]): string {
  const parts = requested.split(" ").filter(Boolean);
  const valid = parts.filter((s) => supported.includes(s));
  return [...new Set(valid)].join(" ");
}

export const MCP_SCOPE_PERMISSIONS = [
  "mcp:read",
  "mcp:authoring",
  "mcp:admin",
  "metrics:read",
] as const;

export { METRICS_SCOPE } from "../../../auth/index.ts";

export async function permittedMcpScopes(
  db: Db,
  tenantId: string,
  userId: string,
  roleName: string | null,
): Promise<string[]> {
  const principal: ResolvedPrincipal = {
    provider: "oidc",
    kind: "user",
    id: userId,
    tenant_id: tenantId,
    roles: roleName ? [roleName] : [],
    scopes: [],
  };
  const allowed: string[] = [];
  for (const permission of MCP_SCOPE_PERMISSIONS) {
    const decision = await can(db, { tenant_id: tenantId, principal, permission, quiet: true });
    if (decision.allow) allowed.push(permission);
  }
  return allowed;
}

export async function sessionIsLive(db: Db, sessionId: string, tenantId: string): Promise<boolean> {
  return touchSessionIfLive(db, sessionId, tenantId);
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

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

export const FORM_BODY_MAX_BYTES = 64 * 1024;
export async function parseFormBody(req: Request): Promise<URLSearchParams> {
  const contentLength = req.headers.get("content-length");
  if (contentLength !== null && parseInt(contentLength, 10) > FORM_BODY_MAX_BYTES) {
    throw new PayloadTooLargeError("request body too large");
  }
  const buf = await req.arrayBuffer();
  if (buf.byteLength > FORM_BODY_MAX_BYTES) {
    throw new PayloadTooLargeError("request body too large");
  }
  const text = new TextDecoder().decode(buf);
  return new URLSearchParams(text);
}

export const AuthorizeQuerySchema = z.object({
  tenant_id: z.string().uuid().optional(),
  client_id: z.string().min(1),
  redirect_uri: z.string().min(1),
  response_type: z.string().optional(),
  code_challenge: z.string().optional(),
  code_challenge_method: z.string().optional(),
  scope: z.string().optional(),
  resource: z.string().optional(),
  state: z.string().optional(),
});

export const TokenRequestSchema = z.object({
  grant_type: z.string(),
  code: z.string().max(512).optional(),
  code_verifier: z.string().max(512).optional(),
  redirect_uri: z.string().optional(),
  client_id: z.string().optional(),
  refresh_token: z.string().max(512).optional(),
  scope: z.string().optional(),
  subject_token: z.string().max(512).optional(),
  subject_token_type: z.string().max(256).optional(),
  requested_token_type: z.string().max(256).optional(),
  ttl: z.union([z.string().max(8), z.number()]).optional(),
});

export const RevokeRequestSchema = z.object({
  token: z.string().optional(),
  token_type_hint: z.string().optional(),
});

export const DecisionRequestSchema = z.object({
  csrf_token: z.string().default(""),
  decision: z.enum(["approve", "deny", "switch_account"]),
  client_id: z.string().default(""),
  redirect_uri: z.string().default(""),
  resource: z.string().default(""),
  state: z.string().default(""),
  scope: z.union([z.string(), z.array(z.string())]).optional(),
});
