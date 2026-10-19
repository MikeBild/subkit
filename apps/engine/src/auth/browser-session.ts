import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import * as jose from "jose";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import { getConfig } from "../config/loader.ts";
import type { Db } from "../db/client.ts";
import { sessions } from "../db/schema/index.ts";
import { assertTenantActive, SelfServiceIdentityError } from "../identity/index.ts";
import type { ResolvedPrincipal } from "./types.ts";

export const BROWSER_SESSION_COOKIE = "subkit_session";
export const SESSION_SLIDING_TTL_MS = 8 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_TTL_MS = 24 * 60 * 60 * 1000;

export interface BrowserSessionPayload {
  session_id: string;
  user_id: string;
  tenant_id: string;
}

export function browserSessionSecret(): Uint8Array {
  let configured = "";
  try {
    configured = (getConfig().auth.session.secret ?? "").trim();
  } catch {}
  if (configured) return new TextEncoder().encode(configured);
  return new Uint8Array(
    createHash("sha256")
      .update(`${process.env.MASTER_KEY ?? ""}:session`)
      .digest(),
  );
}

export async function signBrowserSession(payload: BrowserSessionPayload): Promise<string> {
  return new jose.SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor((Date.now() + SESSION_ABSOLUTE_TTL_MS) / 1000))
    .sign(browserSessionSecret());
}

export async function verifyBrowserSession(jwt: string): Promise<BrowserSessionPayload | null> {
  try {
    const { payload } = await jose.jwtVerify(jwt, browserSessionSecret());
    if (
      typeof payload.session_id !== "string" ||
      typeof payload.user_id !== "string" ||
      typeof payload.tenant_id !== "string"
    ) {
      return null;
    }
    return {
      session_id: payload.session_id,
      user_id: payload.user_id,
      tenant_id: payload.tenant_id,
    };
  } catch {
    return null;
  }
}

export function browserSessionFromRequest(req: Request): Promise<BrowserSessionPayload | null> {
  const cookie = req.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${BROWSER_SESSION_COOKIE}=`));
  if (!cookie) return Promise.resolve(null);
  const raw = cookie.slice(BROWSER_SESSION_COOKIE.length + 1);
  return verifyBrowserSession(decodeURIComponent(raw));
}

export async function browserSessionForPrincipal(
  req: Request,
  principal: ResolvedPrincipal | undefined,
): Promise<BrowserSessionPayload | null> {
  if (principal?.kind !== "user" || typeof principal.session_id !== "string") return null;
  const payload = await browserSessionFromRequest(req);
  if (
    payload?.session_id !== principal.session_id ||
    payload.user_id !== principal.id ||
    payload.tenant_id !== principal.tenant_id
  ) {
    return null;
  }
  return payload;
}

export async function signLoginState(payload: Record<string, unknown>): Promise<string> {
  return new jose.SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(browserSessionSecret());
}

export async function verifyLoginState(token: string): Promise<Record<string, unknown> | null> {
  try {
    const { payload } = await jose.jwtVerify(token, browserSessionSecret());
    return payload as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function signBrowserCsrf(payload: BrowserSessionPayload): Promise<string> {
  return new jose.SignJWT({
    purpose: "cockpit_csrf",
    session_id: payload.session_id,
    user_id: payload.user_id,
    tenant_id: payload.tenant_id,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("8h")
    .sign(browserSessionSecret());
}

export async function verifyBrowserCsrf(
  token: string,
  payload: BrowserSessionPayload,
): Promise<boolean> {
  try {
    const { payload: claims } = await jose.jwtVerify(token, browserSessionSecret());
    return (
      claims.purpose === "cockpit_csrf" &&
      claims.session_id === payload.session_id &&
      claims.user_id === payload.user_id &&
      claims.tenant_id === payload.tenant_id
    );
  } catch {
    return false;
  }
}

export function browserSessionCookie(jwt: string, maxAge?: number): string {
  const age = maxAge ?? Math.floor(SESSION_ABSOLUTE_TTL_MS / 1000);
  const secure = process.env.NODE_ENV !== "development" ? " Secure;" : "";
  return `${BROWSER_SESSION_COOKIE}=${encodeURIComponent(jwt)}; Path=/; HttpOnly; SameSite=Lax;${secure} Max-Age=${age}`;
}

export function clearBrowserSessionCookie(): string {
  return `${BROWSER_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function isSafeBrowserRedirect(target: string, publicBaseUrl: string): boolean {
  if (target.startsWith("/") && !target.startsWith("//")) return true;
  try {
    return new URL(target).origin === new URL(publicBaseUrl).origin;
  } catch {
    return false;
  }
}

export async function issueBrowserSession(opts: {
  db: Db;
  tenantId: string;
  userId: string;
  redirectTo: string;
  via: string;
  authIdentityId?: string;
  metadata?: Record<string, unknown>;
}): Promise<Response> {
  try {
    await assertTenantActive(opts.tenantId, opts.db);
  } catch (error) {
    if (error instanceof SelfServiceIdentityError) {
      return new Response(
        JSON.stringify({ code: "tenant_unavailable", message: "workspace is unavailable" }),
        {
          status: 403,
          headers: { "content-type": "application/json" },
        },
      );
    }
    throw error;
  }
  const now = new Date();
  const tokenHash = createHash("sha256").update(randomBytes(32)).digest("hex");
  const [session] = await opts.db
    .insert(sessions)
    .values({
      tenant_id: opts.tenantId,
      user_id: opts.userId,
      auth_identity_id: opts.authIdentityId ?? null,
      expires_at: new Date(now.getTime() + SESSION_SLIDING_TTL_MS),
      absolute_expires_at: new Date(now.getTime() + SESSION_ABSOLUTE_TTL_MS),
      last_seen_at: now,
      token_sha256: tokenHash,
    })
    .returning();
  if (!session) {
    return new Response(JSON.stringify({ code: "session_insert_failed" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
  const jwt = await signBrowserSession({
    session_id: session.id,
    user_id: opts.userId,
    tenant_id: opts.tenantId,
  });
  await auditAwait(
    {
      tenant_id: opts.tenantId,
      actor_type: "user",
      actor_id: opts.userId,
      action: AuditAction.SESSION_ISSUED,
      resource_type: "session",
      resource_id: session.id,
      result: "success",
      metadata: { via: opts.via, ...opts.metadata },
    },
    opts.db,
  );
  await auditAwait(
    {
      tenant_id: opts.tenantId,
      actor_type: "user",
      actor_id: opts.userId,
      action: AuditAction.USER_LOGGED_IN,
      resource_type: "user",
      resource_id: opts.userId,
      result: "success",
      metadata: { via: opts.via, ...opts.metadata },
    },
    opts.db,
  );
  return new Response(null, {
    status: 302,
    headers: {
      location: opts.redirectTo,
      "set-cookie": browserSessionCookie(jwt),
      "cache-control": "no-store",
    },
  });
}

export async function revokeBrowserSession(
  db: Db,
  payload: BrowserSessionPayload | null,
  reason: string,
): Promise<void> {
  if (!payload) return;
  const [row] = await db
    .update(sessions)
    .set({ revoked_at: new Date() })
    .where(eq(sessions.id, payload.session_id))
    .returning();
  if (!row) return;
  await auditAwait(
    {
      tenant_id: row.tenant_id,
      actor_type: "user",
      actor_id: row.user_id,
      action: AuditAction.SESSION_REVOKED,
      resource_type: "session",
      resource_id: row.id,
      result: "success",
      reason,
      metadata: { via: "browser_session" },
    },
    db,
  );
  await auditAwait(
    {
      tenant_id: row.tenant_id,
      actor_type: "user",
      actor_id: row.user_id,
      action: AuditAction.USER_LOGGED_OUT,
      resource_type: "user",
      resource_id: row.user_id,
      result: "success",
      metadata: { via: "browser_session", reason },
    },
    db,
  );
}
