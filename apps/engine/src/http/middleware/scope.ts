import type { MiddlewareHandler } from "hono";
import { audit } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import { WILDCARD_SCOPE } from "../../auth/scopes.ts";
import { ForbiddenError, UnauthorizedError } from "../errors.ts";
import type { AppEnv } from "../openapi.ts";

export function requireScope(scope: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const principal = c.get("principal");
    if (!principal) {
      throw new UnauthorizedError();
    }
    const scopeBound = principal.scopes !== undefined && !principal.scopes.includes(WILDCARD_SCOPE);
    const isAdmin = !scopeBound && principal.roles.includes("admin");
    const hasScope = principal.scopes?.includes(scope) ?? false;
    if (!isAdmin && !hasScope) {
      const db = c.get("db");
      audit(
        {
          tenant_id: principal.tenant_id,
          actor_type: principal.kind === "user" ? "user" : "system_account",
          actor_id: principal.id,
          action: AuditAction.POLICY_DENIED,
          resource_type: "scope",
          resource_id: scope,
          result: "denied",
          reason: `scope_missing:${scope}`,
          metadata: {
            method: c.req.method,
            path: c.req.path,
            required_scope: scope,
            scope_bound: scopeBound,
          },
        },
        db,
      );
      throw new ForbiddenError(`scope_missing:${scope}`);
    }
    await next();
  };
}
