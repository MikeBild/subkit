import { and, eq, gt, isNull, or } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { ResolvedPrincipal } from "../../auth/index.ts";
import {
  type BrowserSessionPayload,
  browserSessionForPrincipal,
  cockpitInstallationIdFromPath,
} from "../../auth/index.ts";
import type { Db } from "../../db/client.ts";
import { sessions, tenants, users } from "../../db/schema/identity.ts";
import { getCockpitInstallation } from "../../identity/index.ts";
import type { AppEnv } from "../openapi.ts";

const APP_TENANT_SWITCH_PATHS = new Set([
  "/v1/identity/memberships",
  "/v1/identity/tenant-session",
  "/v1/identity/owned-tenant/restore",
]);
const APP_LOGIN_PATHS = new Set(["/v1/identity/cockpit-login", "/v1/identity/login/start"]);

export interface CockpitInstallationContext {
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
  const now = new Date();
  const slidingCutoff = new Date(now.getTime() - 8 * 60 * 60 * 1000);
  const [session] = await db
    .select({ expires_at: sessions.expires_at })
    .from(sessions)
    .innerJoin(users, and(eq(users.tenant_id, sessions.tenant_id), eq(users.id, sessions.user_id)))
    .innerJoin(tenants, eq(tenants.id, sessions.tenant_id))
    .where(
      and(
        eq(sessions.id, payload.session_id),
        eq(sessions.installation_id, installation.id),
        eq(sessions.tenant_id, installation.tenant_id),
        eq(sessions.user_id, installation.owner_user_id),
        isNull(sessions.revoked_at),
        gt(sessions.expires_at, now),
        or(isNull(sessions.absolute_expires_at), gt(sessions.absolute_expires_at, now)),
        gt(sessions.last_seen_at, slidingCutoff),
        eq(users.status, "active"),
        isNull(users.deleted_at),
        eq(tenants.status, "active"),
        isNull(tenants.deleted_at),
      ),
    )
    .limit(1);
  if (!session) return null;
  return {
    installation_id: installation.id,
    tenant_id: installation.tenant_id,
    user_id: installation.owner_user_id,
    session_id: payload.session_id,
    expires_at: session.expires_at,
  };
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
      return c.json(
        {
          code: "installation_session_required",
          message: "this Cockpit installation requires its own session",
        },
        401,
      );
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
