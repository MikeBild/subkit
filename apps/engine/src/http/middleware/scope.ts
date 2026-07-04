// Scope gate for routes that are auth'd but require a specific OAuth-style
// scope token (e.g. `metrics:read`). Admins bypass the scope check so an
// operator with `role: admin` never has to enumerate every scope they own.
//
// Denials are recorded as `policy.denied` audit rows with a structured
// `reason: "scope_missing:<scope>"` so operators can see exactly which
// route turned the request away. 401 is raised for missing principals
// and 403 for authenticated principals that lack the scope.

import type { MiddlewareHandler } from "hono";
import { audit } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import { ForbiddenError, UnauthorizedError } from "../errors.ts";
import type { AppEnv } from "../openapi.ts";

export function requireScope(scope: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const principal = c.get("principal");
    if (!principal) {
      throw new UnauthorizedError();
    }
    const isAdmin = principal.roles.includes("admin");
    const hasScope = principal.scopes?.includes(scope) ?? false;
    if (!isAdmin && !hasScope) {
      // Bind the audit write to the same request-scoped db handle so
      // tests with a per-suite disposable database observe the row.
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
          },
        },
        db,
      );
      throw new ForbiddenError(`scope_missing:${scope}`);
    }
    await next();
  };
}
