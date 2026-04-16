// Auth middleware — resolves the request's principal via the auth registry
// and attaches it to the Hono context. Routes opt in to a hard requirement
// via `requireAuth`. Unauthenticated requests can still reach explicitly
// public routes (health, openapi, docs).

import type { MiddlewareHandler } from "hono";
import { recordAuthFailure } from "../../auth/failed-auth-tracker.ts";
import type { AuthProviderRegistry } from "../../auth/registry.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { withContext } from "../../logging/context.ts";
import { UnauthorizedError } from "../errors.ts";
import type { AppEnv } from "../openapi.ts";

export function authMiddleware(registry: AuthProviderRegistry): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const principal = await registry.resolve(c.req.raw);
    if (principal) {
      c.set("principal", principal);
      // Layer tenant + actor onto the async context for downstream logs.
      await withContext(
        {
          tenant_id: principal.tenant_id,
          actor_id: principal.id,
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
