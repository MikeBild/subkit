// `requirePermission` middleware — every protected route uses it to
// gate itself on a named RBAC permission.
//
// Usage:
//   app.use(
//     "/v1/workflows",
//     requirePermission("workflow:read"),
//   );
//   app.use(
//     "/v1/workflows/:id",
//     requirePermission("workflow:read", (c) => ({
//       type: "workflow",
//       id: c.req.param("id") ?? "",
//     })),
//   );
//
// Behaviour:
//   - Reads `c.get("principal")` + `c.get("db")`.
//   - Calls `can()` from the evaluator.
//   - On deny writes a `policy.denied` audit row with the permission
//     and resource info in metadata and raises `ForbiddenError`.
//
// Unauthenticated requests (`principal === undefined`) are deferred to
// `requireAuth` at the handler level — the middleware only runs the
// permission check when a principal is attached. This matches the
// existing error ordering: 401 beats 403.

import type { Context, MiddlewareHandler } from "hono";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import { can } from "../../rbac/evaluator.ts";
import { ForbiddenError, UnauthorizedError } from "../errors.ts";
import type { AppEnv } from "../openapi.ts";

export type ResourceFromFn = (c: Context<AppEnv>) => { type: string; id: string } | undefined;

export function requirePermission(
  permission: string,
  resourceFrom?: ResourceFromFn,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const principal = c.get("principal");
    if (!principal) {
      throw new UnauthorizedError();
    }
    const db = c.get("db");
    const resource = resourceFrom ? resourceFrom(c) : undefined;
    const resourceArg = resource?.id ? resource : undefined;
    const check = resourceArg
      ? {
          tenant_id: principal.tenant_id,
          principal,
          permission,
          resource: resourceArg,
        }
      : {
          tenant_id: principal.tenant_id,
          principal,
          permission,
        };
    const decision = await can(db, check);
    if (!decision.allow) {
      try {
        await auditAwait(
          {
            tenant_id: principal.tenant_id,
            actor_type: principal.kind,
            actor_id: principal.id,
            action: AuditAction.POLICY_DENIED,
            resource_type: resourceArg?.type ?? "policy",
            resource_id: resourceArg?.id ?? null,
            result: "denied",
            reason: decision.reason ?? `permission_denied:${permission}`,
            metadata: {
              permission,
              resource_type: resourceArg?.type ?? null,
              resource_id: resourceArg?.id ?? null,
            },
          },
          db,
        );
      } catch {
        // audit is best-effort; always raise the 403 regardless.
      }
      throw new ForbiddenError(decision.reason ?? `permission_denied:${permission}`);
    }
    await next();
  };
}

/**
 * Accept the caller if they hold ANY of the listed permissions. Used
 * during deprecation windows when a route is migrating from one perm
 * to another — grant both, allow either. A single `policy.denied`
 * row is written (against the last perm in the list) when all checks
 * fail, so the audit trail still surfaces the denial.
 */
export function requireAnyPermission(
  permissions: readonly string[],
  resourceFrom?: ResourceFromFn,
): MiddlewareHandler<AppEnv> {
  if (permissions.length === 0) {
    throw new Error("requireAnyPermission: at least one permission required");
  }
  return async (c, next) => {
    const principal = c.get("principal");
    if (!principal) {
      throw new UnauthorizedError();
    }
    const db = c.get("db");
    const resource = resourceFrom ? resourceFrom(c) : undefined;
    const resourceArg = resource?.id ? resource : undefined;
    let lastReason: string | undefined;
    for (const permission of permissions) {
      const check = resourceArg
        ? {
            tenant_id: principal.tenant_id,
            principal,
            permission,
            resource: resourceArg,
          }
        : {
            tenant_id: principal.tenant_id,
            principal,
            permission,
          };
      const decision = await can(db, check);
      if (decision.allow) {
        await next();
        return;
      }
      lastReason = decision.reason ?? `permission_denied:${permission}`;
    }
    // All checks failed. Emit one denial row against the primary (first) permission.
    const primary = permissions[0] ?? "unknown";
    try {
      await auditAwait(
        {
          tenant_id: principal.tenant_id,
          actor_type: principal.kind,
          actor_id: principal.id,
          action: AuditAction.POLICY_DENIED,
          resource_type: resourceArg?.type ?? "policy",
          resource_id: resourceArg?.id ?? null,
          result: "denied",
          reason: lastReason ?? `permission_denied:${primary}`,
          metadata: {
            permission: primary,
            permission_alternates: permissions.slice(1),
            resource_type: resourceArg?.type ?? null,
            resource_id: resourceArg?.id ?? null,
          },
        },
        db,
      );
    } catch {
      // audit is best-effort; always raise the 403 regardless.
    }
    throw new ForbiddenError(lastReason ?? `permission_denied:${primary}`);
  };
}
