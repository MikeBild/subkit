import { and, eq, isNull } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { ResolvedPrincipal } from "../../auth/index.ts";
import {
  type BrowserSessionPayload,
  browserSessionDenyReason,
  browserSessionForPrincipal,
  browserSessionFromRequest,
  cockpitInstallationIdFromPath,
  sessionLifetime,
} from "../../auth/index.ts";
import type { Db } from "../../db/client.ts";
import { sessions, tenants, users } from "../../db/schema/identity.ts";
import {
  type CockpitBrowserPushContext,
  type CockpitPushContext,
  getCockpitInstallation,
} from "../../identity/index.ts";
import type { AppEnv } from "../openapi.ts";

const APP_TENANT_SWITCH_PATHS = new Set([
  "/v1/identity/memberships",
  "/v1/identity/tenant-session",
  "/v1/identity/owned-tenant/restore",
]);
const APP_LOGIN_PATHS = new Set(["/v1/identity/cockpit-login", "/v1/identity/login/start"]);
const sessionValiditySelection = {
  expires_at: sessions.expires_at,
  revoked_at: sessions.revoked_at,
  absolute_expires_at: sessions.absolute_expires_at,
  last_seen_at: sessions.last_seen_at,
};

interface CockpitInstallationContext {
  installation_id: string;
  tenant_id: string;
  user_id: string;
  session_id: string;
  expires_at: Date | null;
}

export async function resolveCockpitInstallationContext(
  db: Db,
  request: Request,
  principal: ResolvedPrincipal | undefined,
): Promise<CockpitInstallationContext | null> {
  const installationId = cockpitInstallationIdFromPath(new URL(request.url).pathname);
  if (!installationId || principal?.provider !== "browser_session" || principal.kind !== "user") {
    return null;
  }
  const payload: BrowserSessionPayload | null = await browserSessionForPrincipal(
    request,
    principal,
  );
  if (!payload?.installation_id || payload.installation_id !== installationId) return null;
  const installation = await getCockpitInstallation(db, installationId);
  if (
    !installation ||
    installation.revoked_at ||
    installation.tenant_id !== principal.tenant_id ||
    installation.owner_user_id !== principal.id ||
    principal.session_id !== payload.session_id
  ) {
    return null;
  }
  const [session] = await db
    .select(sessionValiditySelection)
    .from(sessions)
    .innerJoin(users, and(eq(users.tenant_id, sessions.tenant_id), eq(users.id, sessions.user_id)))
    .innerJoin(tenants, eq(tenants.id, sessions.tenant_id))
    .where(
      and(
        eq(sessions.id, payload.session_id),
        eq(sessions.installation_id, installation.id),
        eq(sessions.tenant_id, installation.tenant_id),
        eq(sessions.user_id, installation.owner_user_id),
        eq(users.status, "active"),
        isNull(users.deleted_at),
        eq(tenants.status, "active"),
        isNull(tenants.deleted_at),
      ),
    )
    .limit(1);
  if (
    !session ||
    browserSessionDenyReason(session, new Date(), sessionLifetime(installation.kind).sliding_ms)
  )
    return null;
  return {
    installation_id: installation.id,
    tenant_id: installation.tenant_id,
    user_id: installation.owner_user_id,
    session_id: payload.session_id,
    expires_at: session.expires_at,
  };
}

async function resolveCockpitBrowserPushContext(
  db: Db,
  request: Request,
  principal: ResolvedPrincipal | undefined,
): Promise<CockpitBrowserPushContext | null> {
  if (cockpitInstallationIdFromPath(new URL(request.url).pathname)) return null;
  if (principal?.provider !== "browser_session" || principal.kind !== "user") return null;
  const payload = await browserSessionForPrincipal(request, principal);
  if (!payload || payload.installation_id || principal.session_id !== payload.session_id)
    return null;
  const [session] = await db
    .select(sessionValiditySelection)
    .from(sessions)
    .innerJoin(users, and(eq(users.tenant_id, sessions.tenant_id), eq(users.id, sessions.user_id)))
    .innerJoin(tenants, eq(tenants.id, sessions.tenant_id))
    .where(
      and(
        eq(sessions.id, payload.session_id),
        eq(sessions.tenant_id, principal.tenant_id),
        eq(sessions.user_id, principal.id),
        isNull(sessions.installation_id),
        eq(users.status, "active"),
        isNull(users.deleted_at),
        eq(tenants.status, "active"),
        isNull(tenants.deleted_at),
      ),
    )
    .limit(1);
  if (!session || browserSessionDenyReason(session, new Date())) return null;
  return {
    kind: "browser",
    tenant_id: principal.tenant_id,
    user_id: principal.id,
    session_id: payload.session_id,
    expires_at: session.expires_at,
  };
}

export async function resolveCockpitPushContext(
  db: Db,
  request: Request,
  principal: ResolvedPrincipal | undefined,
): Promise<CockpitPushContext | null> {
  if (cockpitInstallationIdFromPath(new URL(request.url).pathname)) {
    const installation = await resolveCockpitInstallationContext(db, request, principal);
    return installation ? { kind: "installation", ...installation } : null;
  }
  return await resolveCockpitBrowserPushContext(db, request, principal);
}

interface InstallationRefusal {
  status: 401 | 403;
  code: "installation_session_required" | "installation_revoked";
  message: string;
}

export function cockpitInstallationRefusal(
  installation: { tenant_id: string; owner_user_id: string; revoked_at: Date | null } | null,
  cookie: Pick<BrowserSessionPayload, "tenant_id" | "user_id"> | null,
): InstallationRefusal {
  if (
    cookie &&
    installation?.revoked_at &&
    installation.tenant_id === cookie.tenant_id &&
    installation.owner_user_id === cookie.user_id
  )
    return {
      status: 403,
      code: "installation_revoked",
      message: "this Cockpit installation was revoked",
    };
  return {
    status: 401,
    code: "installation_session_required",
    message: "this Cockpit installation requires its own session",
  };
}

export async function cockpitInstallationRefusalFor(
  db: Db,
  request: Request,
): Promise<InstallationRefusal> {
  const installationId = cockpitInstallationIdFromPath(new URL(request.url).pathname);
  const cookie = installationId ? await browserSessionFromRequest(request) : null;
  return cockpitInstallationRefusal(
    cookie && installationId ? await getCockpitInstallation(db, installationId) : null,
    cookie,
  );
}

export function requireCockpitInstallation(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const installationId = cockpitInstallationIdFromPath(c.req.path);
    if (!installationId) {
      return c.json(
        { code: "installation_not_found", message: "Cockpit installation not found" },
        404,
      );
    }
    const canonical = c.req.path.replace(/^\/cockpit\/i\/[0-9a-f-]+\/api/i, "");
    if (APP_LOGIN_PATHS.has(canonical)) return await next();
    const context = await resolveCockpitInstallationContext(
      c.get("db"),
      c.req.raw,
      c.get("principal"),
    );
    if (!context) {
      if (c.req.method === "GET" && canonical === "/v1/tool-approvals/decide") {
        const target = `${c.req.path}${new URL(c.req.url).search}`;
        return c.redirect(
          `/cockpit/i/${installationId}/api/v1/identity/cockpit-login?return_to=${encodeURIComponent(target)}`,
          302,
        );
      }
      const refusal = await cockpitInstallationRefusalFor(c.get("db"), c.req.raw);
      return c.json({ code: refusal.code, message: refusal.message }, refusal.status);
    }
    if (APP_TENANT_SWITCH_PATHS.has(canonical)) {
      return c.json(
        {
          code: "installation_tenant_fixed",
          message: "this Cockpit installation is bound to one workspace",
        },
        403,
      );
    }
    return await next();
  };
}
