import type { MiddlewareHandler } from "hono";
import { browserSessionForPrincipal } from "../../auth/browser-session.ts";
import { recordAuthFailure } from "../../auth/failed-auth-tracker.ts";
import type { AuthProviderRegistry } from "../../auth/registry.ts";
import { isAuthDenial, type ResolvedPrincipal } from "../../auth/types.ts";
import { beginTenantWork } from "../../execution/tenant-work.ts";
import { assertTenantActive, SelfServiceIdentityError } from "../../identity/self-service.ts";
import { withContext } from "../../logging/context.ts";
import { buildServiceMetadata } from "../../observability/service-metadata.ts";
import { UnauthorizedError } from "../errors.ts";
import type { AppEnv } from "../openapi.ts";

export function authMiddleware(registry: AuthProviderRegistry): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.req.method === "POST" && c.req.path === "/v1/identity/cli-session") {
      return next();
    }
    const principal = await registry.resolve(c.req.raw);
    if (isAuthDenial(principal)) {
      recordAuthFailure(c.get("client_ip") ?? "unknown");
      return c.json(
        { code: "unauthorized", error: "unauthorized", message: "invalid bearer token" },
        401,
      );
    }
    if (principal) {
      const release = beginTenantWork(principal.tenant_id);
      try {
        try {
          await assertTenantActive(principal.tenant_id, c.get("db"));
        } catch (err) {
          if (!(err instanceof SelfServiceIdentityError)) throw err;
          return c.json(
            { code: "tenant_unavailable", message: "tenant access is unavailable" },
            403,
          );
        }
        c.set("principal", principal);
        const cockpitRequest =
          c.req.header("x-subkit-client") === "cockpit" &&
          Boolean(await browserSessionForPrincipal(c.req.raw, principal));
        if (cockpitRequest) c.set("request_source", "ui");
        const requestSource = cockpitRequest ? "ui" : (c.get("request_source") ?? "api");
        const auditSource =
          cockpitRequest && c.req.path.startsWith("/v1/conversations") ? "chat" : requestSource;
        c.set(
          "service_metadata",
          buildServiceMetadata({
            trace_id: c.get("trace_id"),
            tenant_id: principal.tenant_id,
            actor_id: principal.id,
            actor_email: principal.email ?? null,
            request_source: requestSource,
          }),
        );
        await withContext(
          {
            tenant_id: principal.tenant_id,
            actor_id: principal.id,
            request_source: requestSource,
            audit_origin_source: auditSource,
            audit_execution_source: auditSource,
            ...(principal.api_key_id ? { api_key_id: principal.api_key_id } : {}),
            ...(principal.session_id ? { session_id: principal.session_id } : {}),
            ...(principal.auth_source
              ? { audit_access_type: principal.auth_source.kind }
              : principal.provider === "portal_token"
                ? { audit_access_type: "portal_token" as const }
                : {}),
            ...(principal.oauth_client_id
              ? { audit_oauth_client_id: principal.oauth_client_id }
              : {}),
            ...(principal.credential_origin
              ? { audit_credential_origin: principal.credential_origin }
              : {}),
            ...(principal.via ? { auth_via: principal.via } : {}),
          },
          async () => {
            await next();
          },
        );
        return undefined;
      } finally {
        release();
      }
    }
    if (c.req.header("authorization")) {
      recordAuthFailure(c.get("client_ip") ?? "unknown");
    }
    return next();
  };
}

export function requireAuth(c: {
  get: (k: "principal") => ResolvedPrincipal | undefined;
}): ResolvedPrincipal {
  const principal = c.get("principal");
  if (!principal) {
    throw new UnauthorizedError();
  }
  return principal;
}
