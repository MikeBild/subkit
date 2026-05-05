// Policy evaluator — RBAC + ABAC rules enforced at REST, MCP, and webhook
// surfaces. RBAC is the role/permission check below; QuickJS-backed
// before-request hooks live in `auth/hooks.ts` + the `request_hooks`
// table and run from the route middleware in addition to this evaluator.

import type { PolicyContext, PolicyDecision, ResolvedPrincipal } from "./types.ts";

export type Role = "admin" | "member" | "enduser";

function roles(p: ResolvedPrincipal): ReadonlySet<Role> {
  return new Set(p.roles as Role[]);
}

function hasRole(p: ResolvedPrincipal, ...want: Role[]): boolean {
  const r = roles(p);
  return want.some((w) => r.has(w));
}

export interface RouteSpec {
  // Required role(s). Empty array means any authenticated principal.
  requireRole?: Role[];
  // True if the route is read-only — `member` may pass.
  readOnly?: boolean;
  // Allow the principal to act on themselves regardless of role
  // (the route handler must compare ids and pass `selfMatch: true`).
  allowSelf?: boolean;
}

export function checkRoute(
  principal: ResolvedPrincipal,
  spec: RouteSpec,
  selfMatch = false,
): PolicyDecision {
  // enduser is always denied for identity routes in P2.
  if (hasRole(principal, "enduser") && !selfMatch) {
    return { allowed: false, reason: "enduser_denied" };
  }

  if (spec.allowSelf && selfMatch) {
    return { allowed: true };
  }

  if (spec.requireRole && spec.requireRole.length > 0) {
    if (!hasRole(principal, ...spec.requireRole)) {
      // member may still pass if the route is read-only.
      if (spec.readOnly && hasRole(principal, "member")) {
        return { allowed: true };
      }
      return { allowed: false, reason: `requires_role:${spec.requireRole.join("|")}` };
    }
  }

  return { allowed: true };
}

/**
 * Convenience helpers used by route handlers — declarative and readable.
 */
export const policy = {
  adminOnly(principal: ResolvedPrincipal, selfMatch = false): PolicyDecision {
    return checkRoute(principal, { requireRole: ["admin"] }, selfMatch);
  },
  adminReadOnly(principal: ResolvedPrincipal, selfMatch = false): PolicyDecision {
    return checkRoute(principal, { requireRole: ["admin"], readOnly: true }, selfMatch);
  },
  adminOrSelf(principal: ResolvedPrincipal, selfMatch: boolean): PolicyDecision {
    return checkRoute(principal, { requireRole: ["admin"], allowSelf: true }, selfMatch);
  },
};

// Re-export so test code can construct PolicyContext objects without
// importing from two places.
export type { PolicyContext };
