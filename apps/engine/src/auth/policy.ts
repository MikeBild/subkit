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
  requireRole?: Role[];
  readOnly?: boolean;
  allowSelf?: boolean;
}

export function checkRoute(
  principal: ResolvedPrincipal,
  spec: RouteSpec,
  selfMatch = false,
): PolicyDecision {
  if (hasRole(principal, "enduser") && !selfMatch) {
    return { allowed: false, reason: "enduser_denied" };
  }

  if (spec.allowSelf && selfMatch) {
    return { allowed: true };
  }

  if (spec.requireRole && spec.requireRole.length > 0) {
    if (!hasRole(principal, ...spec.requireRole)) {
      if (spec.readOnly && hasRole(principal, "member")) {
        return { allowed: true };
      }
      return { allowed: false, reason: `requires_role:${spec.requireRole.join("|")}` };
    }
  }

  return { allowed: true };
}

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

export type { PolicyContext };
