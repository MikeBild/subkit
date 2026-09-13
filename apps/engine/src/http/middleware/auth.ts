// Auth middleware — resolves the request's principal via the auth registry
// and attaches it to the Hono context. Routes opt in to a hard requirement
// via `requireAuth`. Unauthenticated requests can still reach explicitly
// public routes (health, openapi, docs).

import type { MiddlewareHandler } from "hono";

import { browserSessionForPrincipal } from "../../auth/browser-session.ts";
import { recordAuthFailure } from "../../auth/failed-auth-tracker.ts";
import type { AuthProviderRegistry } from "../../auth/registry.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { withContext } from "../../logging/context.ts";
import { buildServiceMetadata } from "../../observability/service-metadata.ts";
import { UnauthorizedError } from "../errors.ts";
import type { AppEnv } from "../openapi.ts";

export function authMiddleware(registry: AuthProviderRegistry): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    // This resource consumes a dedicated, one-time OAuth audience itself. The
    // general registry intentionally rejects that audience; resolving it here
    // first would misclassify every valid CLI exchange as a failed API login
    // and feed the brute-force tracker before the route accepts it.
    if (c.req.method === "POST" && c.req.path === "/v1/identity/cli-session") {
      await next();
      return;
    }
    const principal = await registry.resolve(c.req.raw);
    if (principal) {
      c.set("principal", principal);
      const cockpitRequest =
        c.req.header("x-subkit-client") === "cockpit" &&
        Boolean(await browserSessionForPrincipal(c.req.raw, principal));
      if (cockpitRequest) c.set("request_source", "ui");
      // Compose the identity envelope once per request. Downstream code
      // pulls `service_metadata` instead of re-deriving from individual
      // ctx fields, so audit / telemetry / execution / notifications all
      // see the same trace_id + tenant_id + actor.
      c.set(
        "service_metadata",
        buildServiceMetadata({
          trace_id: c.get("trace_id"),
          tenant_id: principal.tenant_id,
          actor_id: principal.id,
          actor_email: principal.email ?? null,
          request_source: cockpitRequest ? "ui" : (c.get("request_source") ?? "api"),
        }),
      );
      // Layer tenant + actor onto the async context for downstream logs.
      await withContext(
        {
          tenant_id: principal.tenant_id,
          actor_id: principal.id,
          request_source: cockpitRequest ? "ui" : (c.get("request_source") ?? "api"),
          ...(principal.via ? { auth_via: principal.via } : {}),
        },
        async () => {
          await next();
        },
      );
      return;
    }
    // Track failed attempts when a credential was provided but no provider accepted it.
    if (c.req.header("authorization")) {
      const ip =
        c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
        c.req.header("x-real-ip") ??
        "unknown";
      recordAuthFailure(ip);
    }
    await next();
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
