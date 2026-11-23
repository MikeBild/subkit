import { and, eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { browserSessionForPrincipal, canonicalBrowserPath } from "../../auth/browser-session.ts";
import { sessions } from "../../db/schema/index.ts";
import { logger } from "../../logging/index.ts";
import { isBrowserPageRoute } from "../browser-pages.ts";
import type { AppEnv } from "../openapi.ts";

const IDENTITY_PATHS = new Set([
  "/v1/cockpit/bootstrap",
  "/v1/identity/memberships",
  "/v1/identity/tenant-session",
  "/v1/identity/recovery",
  "/v1/identity/recovery/providers",
  "/v1/identity/recovery/login",
  "/v1/identity/owned-tenant/restore",
  "/v1/identity/onboarding",
  "/v1/identity/invites/preview",
  "/v1/identity/invites/login",
]);

export function browserTenantMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const path = canonicalBrowserPath(c.req.raw);
    if (
      IDENTITY_PATHS.has(path) ||
      path.startsWith("/v1/identity/login/") ||
      isBrowserPageRoute(c.req.method, path) ||
      path.startsWith("/v1/oauth/") ||
      path.startsWith("/v1/tool-approvals/")
    ) {
      return next();
    }
    const principal = c.get("principal");
    const payload = await browserSessionForPrincipal(c.req.raw, principal);
    if (!payload) return next();
    const [session] = await c
      .get("db")
      .select({ auth_identity_id: sessions.auth_identity_id })
      .from(sessions)
      .where(
        and(
          eq(sessions.id, payload.session_id),
          eq(sessions.tenant_id, payload.tenant_id),
          eq(sessions.user_id, payload.user_id),
        ),
      )
      .limit(1);
    if (!session?.auth_identity_id) return next();
    const expectedTenant =
      c.req.header("x-subkit-tenant") ??
      (c.req.method === "GET" &&
      (/^\/v1\/files\/[^/]+\/content$/.test(path) ||
        path === "/v1/tenant/branding/logo" ||
        path === "/v1/tenant/branding/icon")
        ? c.req.query("tenant_context")
        : undefined);
    if (expectedTenant !== payload.tenant_id) {
      logger.warn({
        module: "http",
        action: "browser_tenant.context_changed",
        msg: expectedTenant
          ? "browser request names another workspace than its session"
          : "browser request carries no workspace context for its session",
        reason: expectedTenant ? "tenant_mismatch" : "tenant_header_missing",
        path,
        method: c.req.method,
        session_tenant_id: payload.tenant_id,
        ...(expectedTenant ? { expected_tenant_id: expectedTenant } : {}),
        fetch_mode: c.req.header("sec-fetch-mode") ?? null,
      });
      return c.json(
        {
          code: "tenant_context_changed",
          message: "Reload the workspace session before continuing.",
        },
        409,
      );
    }
    return next();
  };
}
