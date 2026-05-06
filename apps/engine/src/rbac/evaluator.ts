// Centralized RBAC permission evaluator.
//
// `can(db, check)` returns a `Decision` answering whether the
// principal holds `permission` on the target resource. Callers use
// the returned `Decision.allow` + `Decision.reason` to either let the
// request through or raise `ForbiddenError`.
//
// Evaluation order (first match wins):
//   1. Built-in `admin` role on the principal → `builtin_admin`.
//   2. Direct `resource_grants` row for this (subject, resource,
//      permission) → `resource_grant`.
//   3. Group membership → `group_role_assignments` → `role_permissions`
//      → `group`.
//   4. Principal `role_id` → `role_permissions` → `role`.
//   5. Portal token `allowed_workflows` matches for `workflow:run` or
//      `workflow:read` → `portal_token_allowlist`.
//   6. Otherwise deny with `reason: "permission_denied:<permission>"`.
//
// Every outcome bumps the `rbac_checks_total` counter with labels
// `{result, permission, source}` so operators can see deny rates per
// permission in Prometheus.

import { and, eq, isNull, or } from "drizzle-orm";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";
import {
  groupMembers,
  groupRoleAssignments,
  permissions as permissionsTable,
  resourceGrants,
  rolePermissions,
  roles as rolesTable,
  users,
} from "../db/schema/index.ts";
import { log } from "../logging/logger.ts";
import { getMetrics, METRIC_NAMES } from "../observability/metrics.ts";

export type DecisionSource =
  | "builtin_admin"
  | "resource_grant"
  | "group"
  | "role"
  | "portal_token_allowlist";

export interface PermissionCheck {
  tenant_id: string;
  principal: ResolvedPrincipal;
  permission: string;
  resource?: { type: string; id: string };
}

export interface Decision {
  allow: boolean;
  reason?: string;
  source?: DecisionSource;
}

function recordMetric(result: "allow" | "deny", permission: string, source: string): void {
  try {
    getMetrics().inc(METRIC_NAMES.RBAC_CHECKS_TOTAL, { result, permission, source }, 1);
  } catch {
    // metrics are best-effort — never let a label mismatch crash a request.
  }
}

async function lookupPermissionId(db: Db, name: string): Promise<string | null> {
  // tenant-filter:exempt — RBAC catalog walk — handles both global rows (tenant_id IS NULL) and tenant rows
  const rows = await db
    .select({ id: permissionsTable.id })
    .from(permissionsTable)
    .where(eq(permissionsTable.name, name))
    .limit(1);
  return rows[0]?.id ?? null;
}

async function lookupBuiltinRoleIdByName(db: Db, name: string): Promise<string | null> {
  const rows = await db
    .select({ id: rolesTable.id })
    .from(rolesTable)
    .where(and(isNull(rolesTable.tenant_id), eq(rolesTable.name, name)))
    .limit(1);
  return rows[0]?.id ?? null;
}

async function principalRoleId(db: Db, principal: ResolvedPrincipal): Promise<string | null> {
  if (principal.kind === "user") {
    // tenant-filter:exempt — RBAC catalog walk — handles both global rows (tenant_id IS NULL) and tenant rows
    const rows = await db
      .select({ role_id: users.role_id })
      .from(users)
      .where(eq(users.id, principal.id))
      .limit(1);
    if (rows[0]?.role_id) return rows[0].role_id;
    // Legacy fallback: honor the `principal.roles` names (derived
    // from the enum column) so users that predate the RBAC backfill
    // still resolve a role_id via the built-in table.
    for (const name of principal.roles ?? []) {
      const id = await lookupBuiltinRoleIdByName(db, name);
      if (id) return id;
    }
    return null;
  }
  // system_account
  const { systemAccounts } = await import("../db/schema/index.ts");
  // tenant-filter:exempt — RBAC catalog walk — handles both global rows (tenant_id IS NULL) and tenant rows
  const rows = await db
    .select({ role_id: systemAccounts.role_id })
    .from(systemAccounts)
    .where(eq(systemAccounts.id, principal.id))
    .limit(1);
  if (rows[0]?.role_id) return rows[0].role_id;
  for (const name of principal.roles ?? []) {
    const id = await lookupBuiltinRoleIdByName(db, name);
    if (id) return id;
  }
  return null;
}

async function roleHasPermission(db: Db, roleId: string, permissionId: string): Promise<boolean> {
  // tenant-filter:exempt — RBAC catalog walk — handles both global rows (tenant_id IS NULL) and tenant rows
  const rows = await db
    .select({ role_id: rolePermissions.role_id })
    .from(rolePermissions)
    .where(
      and(eq(rolePermissions.role_id, roleId), eq(rolePermissions.permission_id, permissionId)),
    )
    .limit(1);
  return rows.length > 0;
}

async function groupGrantsPermission(
  db: Db,
  userId: string,
  permissionId: string,
): Promise<boolean> {
  // Join group_members → group_role_assignments → role_permissions.
  // tenant-filter:exempt — RBAC catalog walk — handles both global rows (tenant_id IS NULL) and tenant rows
  const rows = await db
    .select({ group_id: groupMembers.group_id })
    .from(groupMembers)
    .innerJoin(groupRoleAssignments, eq(groupRoleAssignments.group_id, groupMembers.group_id))
    .innerJoin(rolePermissions, eq(rolePermissions.role_id, groupRoleAssignments.role_id))
    .where(and(eq(groupMembers.user_id, userId), eq(rolePermissions.permission_id, permissionId)))
    .limit(1);
  return rows.length > 0;
}

async function hasResourceGrant(
  db: Db,
  check: PermissionCheck,
  permissionId: string,
): Promise<boolean> {
  if (!check.resource) return false;
  const subjectType = check.principal.kind; // user | system_account
  const rows = await db
    .select({ id: resourceGrants.id })
    .from(resourceGrants)
    .where(
      and(
        eq(resourceGrants.tenant_id, check.tenant_id),
        eq(resourceGrants.subject_type, subjectType),
        eq(resourceGrants.subject_id, check.principal.id),
        eq(resourceGrants.resource_type, check.resource.type),
        eq(resourceGrants.resource_id, check.resource.id),
        eq(resourceGrants.permission_id, permissionId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

function matchesPortalTokenAllowlist(check: PermissionCheck): boolean {
  // The `portal_token_user` built-in role plus the allowlist together
  // define what an end-user principal can do. The allowlist path has
  // two families:
  //
  //   1. Workflow-scoped execution (`workflow:run` / `workflow:read`):
  //      the resource MUST be the targeted workflow id and the id MUST
  //      be on the allowlist (or the allowlist is `"all"`).
  //
  //   2. Conversation surfaces (`conversation:read` / `conversation:write`
  //      / `conversation:cancel`): portal-token principals can chat, but
  //      the route gate does not know which workflow a turn is about to
  //      touch, so we do not require a resource here. The conversations
  //      service layer enforces that every mutation resolves to a
  //      workflow on the allowlist — a portal-token holder cannot read
  //      or write conversations that reference workflows outside their
  //      scope. `conversation:approve`, `conversation:commit`,
  //      `memory:write`, and `mcp:read` are deliberately not exposed
  //      here: end-users cannot approve their own drafts, commit
  //      workflows, attach free-form memory, or introspect MCP.
  if (check.principal.provider !== "portal_token") return false;
  const allow = check.principal.allowed_workflows;
  if (allow === undefined) return false;
  const perm = check.permission;
  if (perm === "workflow:run" || perm === "workflow:read") {
    if (!check.resource || check.resource.type !== "workflow") return false;
    if (allow === "all") return true;
    return Array.isArray(allow) && allow.includes(check.resource.id);
  }
  if (
    perm === "conversation:read" ||
    perm === "conversation:write" ||
    perm === "conversation:cancel"
  ) {
    // The allowlist must exist — empty arrays deny. Resource-level
    // enforcement happens in the conversations service layer.
    if (allow === "all") return true;
    return Array.isArray(allow) && allow.length > 0;
  }
  return false;
}

function hasBuiltinAdminRole(principal: ResolvedPrincipal): boolean {
  return principal.roles?.includes("admin") === true;
}

const rbacCtx = (check: PermissionCheck) => ({
  permission: check.permission,
  principal_kind: check.principal.kind,
  principal_id: check.principal.id,
  resource_type: check.resource?.type,
  resource_id: check.resource?.id,
});

export async function can(db: Db, check: PermissionCheck): Promise<Decision> {
  // 1. admin short-circuit.
  if (hasBuiltinAdminRole(check.principal)) {
    recordMetric("allow", check.permission, "builtin_admin");
    log.rbac.checked({ allow: true, source: "builtin_admin", ...rbacCtx(check) });
    return { allow: true, source: "builtin_admin" };
  }

  const permissionId = await lookupPermissionId(db, check.permission);
  if (!permissionId) {
    // Unknown permission name — deny. Surfaces early during development.
    recordMetric("deny", check.permission, "unknown_permission");
    log.rbac.denied({ reason: `permission_unknown:${check.permission}`, ...rbacCtx(check) });
    return {
      allow: false,
      reason: `permission_unknown:${check.permission}`,
    };
  }

  // SECURITY: Portal-token principals are scoped strictly to their
  // `allowed_workflows` allowlist and MUST NOT inherit the underlying
  // user's role_id, resource grants, or group memberships. Otherwise
  // an admin operator issuing themselves a narrowly-scoped portal token
  // would get admin access back via the role lookup — a classic scope
  // escalation. The `isPortalToken` flag short-circuits every
  // principal-identity path below (resource_grant, role, group) and the
  // evaluator falls through to the portal-token allowlist branch, which
  // is the ONLY allowed route to a positive decision for these
  // principals.
  const isPortalToken = check.principal.provider === "portal_token";

  // 2. resource grant (skipped for portal-token principals so a per-
  //    user grant cannot escalate the token beyond its allowlist).
  if (!isPortalToken && check.resource) {
    const granted = await hasResourceGrant(db, check, permissionId);
    if (granted) {
      recordMetric("allow", check.permission, "resource_grant");
      log.rbac.checked({ allow: true, source: "resource_grant", ...rbacCtx(check) });
      return { allow: true, source: "resource_grant" };
    }
  }

  // 3. group membership (users only, non-portal-token).
  if (!isPortalToken && check.principal.kind === "user") {
    const granted = await groupGrantsPermission(db, check.principal.id, permissionId);
    if (granted) {
      recordMetric("allow", check.permission, "group");
      log.rbac.checked({ allow: true, source: "group", ...rbacCtx(check) });
      return { allow: true, source: "group" };
    }
  }

  // 4. principal role (skipped for portal-token principals).
  if (!isPortalToken) {
    const roleId = await principalRoleId(db, check.principal);
    if (roleId) {
      const granted = await roleHasPermission(db, roleId, permissionId);
      if (granted) {
        recordMetric("allow", check.permission, "role");
        log.rbac.checked({ allow: true, source: "role", ...rbacCtx(check) });
        return { allow: true, source: "role" };
      }
    }
  }

  // 5. portal token allowlist.
  if (matchesPortalTokenAllowlist(check)) {
    recordMetric("allow", check.permission, "portal_token_allowlist");
    log.rbac.checked({ allow: true, source: "portal_token_allowlist", ...rbacCtx(check) });
    return { allow: true, source: "portal_token_allowlist" };
  }

  recordMetric("deny", check.permission, "none");
  // Portal-token principals that fall through without an allowlist match
  // get a workflow-specific reason so operators see why the allowlist
  // rejected them instead of a generic `permission_denied:…`.
  const reason =
    isPortalToken && (check.permission === "workflow:run" || check.permission === "workflow:read")
      ? "workflow_not_in_allowlist"
      : `permission_denied:${check.permission}`;
  log.rbac.denied({ reason, ...rbacCtx(check) });
  return {
    allow: false,
    reason,
  };
}

/**
 * Convenience helper for routes that just need a boolean. Throws if
 * the decision is deny — callers typically want `can()` for the full
 * decision object.
 */
export async function assertCan(db: Db, check: PermissionCheck): Promise<Decision> {
  const d = await can(db, check);
  if (!d.allow) {
    const err = new Error(d.reason ?? "permission_denied");
    (err as { rbac_decision?: Decision }).rbac_decision = d;
    throw err;
  }
  return d;
}

// Re-export symbols some consumers import from here.
export { permissionsTable as rbacPermissions, rolesTable as rbacRoles };

// Suppress unused-import warnings when the evaluator is tree-shaken for tests.
void or;
