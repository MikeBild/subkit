import { createHash } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import * as jose from "jose";
import { getConfig } from "../../config/loader.ts";
import type { Db } from "../../db/client.ts";
import { oidcLoginStates, roles, sessions, users } from "../../db/schema/index.ts";
import { logger } from "../../logging/logger.ts";
import {
  browserSessionDenyReason,
  clearBrowserSessionCookie,
  expireBrowserSession,
  SESSION_ABSOLUTE_TTL_MS,
} from "../browser-session.ts";
import type { ResolvedPrincipal } from "../types.ts";

export const SESSION_COOKIE = "subkit_session";
const JWS_ALG = "HS256";

export function purgeExpiredOidcLoginStates(db: Db): void {
  void db
    .delete(oidcLoginStates)
    .where(lt(oidcLoginStates.expires_at, new Date()))
    .catch(() => {});
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function deriveSessionSecret(override?: Uint8Array): Uint8Array {
  if (override) return override;
  let fromConfig = "";
  try {
    fromConfig = (getConfig().auth.session.secret ?? "").trim();
  } catch {}
  if (fromConfig.length > 0) {
    return new TextEncoder().encode(fromConfig);
  }
  const masterKey = process.env.MASTER_KEY ?? "";
  return new Uint8Array(createHash("sha256").update(`${masterKey}:session`).digest());
}

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

const ACCOUNT_CHOICE_COOKIE = "subkit_login_account_choice";

export function accountChoiceCookie(requested: boolean): string {
  const secure = process.env.NODE_ENV !== "development" ? "; Secure" : "";
  return `${ACCOUNT_CHOICE_COOKIE}=${requested ? "1" : ""}; Path=/v1/identity/login; HttpOnly; SameSite=Lax; Max-Age=${requested ? 600 : 0}${secure}`;
}

export function accountChoiceRequested(req: Request): boolean {
  return parseCookies(req.headers.get("cookie"))[ACCOUNT_CHOICE_COOKIE] === "1";
}

export async function signSessionCookie(
  secret: Uint8Array,
  payload: { session_id: string; user_id: string; tenant_id: string; login_provider?: string },
): Promise<string> {
  return await new jose.SignJWT(payload)
    .setProtectedHeader({ alg: JWS_ALG })
    .setIssuedAt()
    .setExpirationTime(Math.floor((Date.now() + SESSION_ABSOLUTE_TTL_MS) / 1000))
    .sign(secret);
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

export function buildCookieHeader(jwt: string): string {
  const maxAge = Math.floor(SESSION_ABSOLUTE_TTL_MS / 1000);
  const secure = process.env.NODE_ENV !== "development" ? " Secure;" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(
    jwt,
  )}; Path=/; HttpOnly; SameSite=Lax;${secure} Max-Age=${maxAge}`;
}

export function clearCookieHeader(): string {
  return clearBrowserSessionCookie();
}

export async function resolveOidcSession(
  db: Db,
  sessionSecret: Uint8Array,
  req: Request,
): Promise<ResolvedPrincipal | null> {
  const jwt = parseCookies(req.headers.get("cookie"))[SESSION_COOKIE];
  if (!jwt) return null;
  const payload = await verifySessionCookie(sessionSecret, jwt);
  if (!payload) return null;

  // tenant-filter:exempt — session lookup by id resolves the tenant.
  const [row] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, payload.session_id))
    .limit(1);
  if (!row) return null;

  const denyReason = browserSessionDenyReason(row, new Date());
  if (denyReason) {
    if (denyReason !== "revoked") {
      await expireBrowserSession(db, row, denyReason, {
        actorId: null,
        metadata: { via: "oidc_resolve", subject_user_id: row.user_id },
      });
    }
    return null;
  }

  void Promise.resolve().then(() => {
    db.update(sessions)
      .set({ last_seen_at: new Date() })
      .where(eq(sessions.id, row.id))
      .catch((err) => {
        logger.warn({
          module: "auth",
          action: "oidc.last_seen_flush_failed",
          msg: "failed to bump sessions.last_seen_at",
          session_id: row.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  });

  const [user] = await db
    .select({
      role_name: roles.name,
      email: users.email,
      status: users.status,
      deleted_at: users.deleted_at,
    })
    .from(users)
    .leftJoin(roles, eq(roles.id, users.role_id))
    .where(and(eq(users.tenant_id, row.tenant_id), eq(users.id, row.user_id)))
    .limit(1);
  if (user?.status !== "active" || user.deleted_at !== null) return null;

  return {
    provider: "oidc",
    kind: "user",
    id: row.user_id,
    tenant_id: row.tenant_id,
    roles: user.role_name ? [user.role_name] : [],
    session_id: row.id,
    auth_source: { kind: "browser_session", session_id: row.id },
    ...(row.product_id ? { product_id: row.product_id } : {}),
    ...(user.email ? { email: user.email } : {}),
  };
}
