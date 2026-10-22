import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import * as jose from "jose";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import { getConfig } from "../config/loader.ts";
import type { Db } from "../db/client.ts";
import { cockpitInstallations } from "../db/schema/cockpit-installations.ts";
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
  installation_id?: string;
  login_provider?: string;
}

const INSTALLATION_PATH = /^\/cockpit\/i\/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})(?:\/|$)/i;

export function cockpitInstallationIdFromPath(path: string): string | null {
  return INSTALLATION_PATH.exec(path)?.[1]?.toLowerCase() ?? null;
}

export function canonicalBrowserPath(request: Request | URL | string): string {
  const path =
    typeof request === "string"
      ? new URL(request, "https://subkit.invalid").pathname
      : request instanceof URL
        ? request.pathname
        : new URL(request.url).pathname;
  const match = INSTALLATION_PATH.exec(path);
  if (!match) return path;
  const prefix = `/cockpit/i/${match[1]}/api`;
  if (!path.startsWith(`${prefix}/`)) return path;
  return path.slice(prefix.length);
}

export function cockpitInstallationSessionCookie(installationId: string): string {
  return `subkit_installation_${installationId}`;
}

function browserSessionCookieName(request: Request): string | null {
  const installationId = cockpitInstallationIdFromPath(new URL(request.url).pathname);
  return installationId ? cockpitInstallationSessionCookie(installationId) : BROWSER_SESSION_COOKIE;
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
      ...(typeof payload.installation_id === "string"
        ? { installation_id: payload.installation_id }
        : {}),
      ...(typeof payload.login_provider === "string"
        ? { login_provider: payload.login_provider }
        : {}),
    };
  } catch {
    return null;
  }
}

export function browserSessionFromRequest(req: Request): Promise<BrowserSessionPayload | null> {
  const name = browserSessionCookieName(req);
  if (!name) return Promise.resolve(null);
  const cookie = req.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  if (!cookie) return Promise.resolve(null);
  const raw = cookie.slice(name.length + 1);
  return verifyBrowserSession(decodeURIComponent(raw)).then((payload) => {
    const installationId = cockpitInstallationIdFromPath(new URL(req.url).pathname);
    if (installationId && payload?.installation_id !== installationId) return null;
    if (!installationId && payload?.installation_id) return null;
    return payload;
  });
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
    payload.tenant_id !== principal.tenant_id ||
    payload.installation_id !== principal.installation_id
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

export function browserSessionCookie(
  jwt: string,
  maxAge?: number,
  installationId?: string,
): string {
  const age = maxAge ?? Math.floor(SESSION_ABSOLUTE_TTL_MS / 1000);
  const secure = process.env.NODE_ENV !== "development" ? " Secure;" : "";
  const name = installationId
    ? cockpitInstallationSessionCookie(installationId)
    : BROWSER_SESSION_COOKIE;
  const path = installationId ? `/cockpit/i/${installationId}/` : "/";
  return `${name}=${encodeURIComponent(jwt)}; Path=${path}; HttpOnly; SameSite=Lax;${secure} Max-Age=${age}`;
}

export function clearBrowserSessionCookie(installationId?: string): string {
  const name = installationId
    ? cockpitInstallationSessionCookie(installationId)
    : BROWSER_SESSION_COOKIE;
  const path = installationId ? `/cockpit/i/${installationId}/` : "/";
  const secure = process.env.NODE_ENV !== "development" ? " Secure;" : "";
  return `${name}=; Path=${path}; HttpOnly; SameSite=Lax;${secure} Max-Age=0`;
}

export function clearBrowserSessionCookieForRequest(req: Request): string {
  const installationId = cockpitInstallationIdFromPath(new URL(req.url).pathname);
  return clearBrowserSessionCookie(installationId ?? undefined);
}

export function hasBrowserSessionCookie(req: Request): boolean {
  const name = browserSessionCookieName(req);
  return Boolean(
    name &&
      req.headers
        .get("cookie")
        ?.split(";")
        .some((part) => part.trim().startsWith(`${name}=`)),
  );
}

export async function expireBrowserSession(
  db: Db,
  row: { id: string; tenant_id: string; user_id: string },
  reason: "expired_absolute" | "expired_sliding",
  audit: { actorId: string | null; metadata: Record<string, unknown> },
): Promise<void> {
  const [expired] = await db
    .update(sessions)
    .set({ revoked_at: new Date() })
    .where(and(eq(sessions.id, row.id), isNull(sessions.revoked_at)))
    .returning({ id: sessions.id });
  if (!expired) return;
  await auditAwait(
    {
      tenant_id: row.tenant_id,
      actor_type: "system",
      actor_id: audit.actorId,
      action: AuditAction.SESSION_REVOKED,
      resource_type: "session",
      resource_id: row.id,
      result: "denied",
      reason,
      metadata: audit.metadata,
    },
    db,
  );
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
  installationId?: string;
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
  const session = await opts.db.transaction(async (tx) => {
    if (opts.installationId) {
      const locked = await tx.execute(
        sql`select ${cockpitInstallations.id}
            from ${cockpitInstallations}
            where ${cockpitInstallations.id} = ${opts.installationId}
              and ${cockpitInstallations.tenant_id} = ${opts.tenantId}
              and ${cockpitInstallations.owner_user_id} = ${opts.userId}
              and ${cockpitInstallations.revoked_at} is null
            for update`,
      );
      if (locked.rows.length === 0) return null;
    }
    const rows = await tx
      .insert(sessions)
      .values({
        tenant_id: opts.tenantId,
        user_id: opts.userId,
        auth_identity_id: opts.authIdentityId ?? null,
        installation_id: opts.installationId ?? null,
        expires_at: new Date(now.getTime() + SESSION_SLIDING_TTL_MS),
        absolute_expires_at: new Date(now.getTime() + SESSION_ABSOLUTE_TTL_MS),
        last_seen_at: now,
        token_sha256: tokenHash,
      })
      .returning();
    return rows[0] ?? null;
  });
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
    ...(opts.installationId ? { installation_id: opts.installationId } : {}),
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
      "set-cookie": browserSessionCookie(jwt, undefined, opts.installationId),
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
    .where(and(eq(sessions.id, payload.session_id), isNull(sessions.revoked_at)))
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
