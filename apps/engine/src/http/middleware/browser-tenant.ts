import { and, eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { browserSessionForPrincipal } from "../../auth/browser-session.ts";
import { sessions } from "../../db/schema/index.ts";
import type { AppEnv } from "../openapi.ts";

const IDENTITY_PATHS = new Set([
  "/v1/cockpit/bootstrap",
  "/v1/identity/memberships",
  "/v1/identity/tenant-session",
  "/v1/identity/recovery",
  "/v1/identity/recovery/providers",
  "/v1/identity/recovery/login",
  "/v1/identity/owned-tenant/restore",
]);

export function browserTenantMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (
      IDENTITY_PATHS.has(c.req.path) ||
      c.req.path.startsWith("/v1/identity/login/") ||
      c.req.path.startsWith("/v1/oauth/") ||
      c.req.path.startsWith("/v1/tool-approvals/")
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
      (c.req.method === "GET" && /^\/v1\/files\/[^/]+\/content$/.test(c.req.path)
        ? c.req.query("tenant_context")
        : undefined);
    if (expectedTenant !== payload.tenant_id) {
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
