import { isBuiltinAdmin } from "@shared/owner.ts";
import { and, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { ceilingScopes } from "../auth/scopes.ts";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Executor } from "../db/client.ts";
import {
  groupMembers,
  groupRoleAssignments,
  groups,
  permissions as permissionsTable,
  resourceGrants,
  rolePermissions,
  roles as rolesTable,
  users,
} from "../db/schema/index.ts";
import { log } from "../logging/index.ts";
import { getMetrics, METRIC_NAMES } from "../observability/metrics.ts";
import { now } from "../utils/clock.ts";
import { isUuid } from "../utils/index.ts";
import { isOperatorPermission } from "./catalog.ts";
import {
  credentialCeilingCause,
  credentialCeilingDecision,
  deriveConnectorAccessLevel,
  evaluatePermission,
  evaluateResourceAccess,
  matchesPortalTokenAllowlist,
  type PermissionFacts,
} from "./core/evaluator.ts";
import { isOperatorPrincipal } from "./operator.ts";

export type DecisionSource =
  | "builtin_admin"
  | "resource_grant"
  | "group"
  | "role"
  | "portal_token_allowlist"
  | "credential_ceiling"
  | "operator_boundary";

export type ConnectorAccessLevel = "none" | "read-only" | "read-write";

export interface DenyDetail {
  required: string;
  resource?: { type: string; id: string };
  cause: string;
}

export interface PermissionCheck {
  tenant_id: string;
  principal: ResolvedPrincipal;
  permission: string;
  resource?: { type: string; id: string };
  quiet?: boolean;
}

export interface Decision {
  allow: boolean;
  reason?: string;
  source?: DecisionSource;
  detail?: DenyDetail;
}

function recordMetric(result: "allow" | "deny", permission: string, source: string): void {
  try {
    getMetrics().inc(METRIC_NAMES.RBAC_CHECKS_TOTAL, { result, permission, source }, 1);
  } catch {}
}

async function lookupPermissionId(db: Executor, name: string): Promise<string | null> {
  // tenant-filter:exempt — RBAC catalog walk — handles both global rows (tenant_id IS NULL) and tenant rows
  const rows = await db
    .select({ id: permissionsTable.id })
    .from(permissionsTable)
    .where(eq(permissionsTable.name, name))
    .limit(1);
  return rows[0]?.id ?? null;
}

async function lookupBuiltinRoleIdByName(db: Executor, name: string): Promise<string | null> {
  const rows = await db
    .select({ id: rolesTable.id })
    .from(rolesTable)
    .where(and(isNull(rolesTable.tenant_id), eq(rolesTable.name, name)))
    .limit(1);
  return rows[0]?.id ?? null;
}

async function principalRoleId(db: Executor, principal: ResolvedPrincipal): Promise<string | null> {
  if (principal.kind === "user") {
    const rows = await db
      .select({ role_id: users.role_id })
      .from(users)
      .where(and(eq(users.id, principal.id), eq(users.tenant_id, principal.tenant_id)))
      .limit(1);
    if (rows[0]) return rows[0].role_id;
    for (const name of principal.roles ?? []) {
      const id = await lookupBuiltinRoleIdByName(db, name);
      if (id) return id;
    }
    return null;
  }
  const { systemAccounts } = await import("../db/schema/index.ts");
  const rows = await db
    .select({ role_id: systemAccounts.role_id })
    .from(systemAccounts)
    .where(
      and(eq(systemAccounts.id, principal.id), eq(systemAccounts.tenant_id, principal.tenant_id)),
    )
    .limit(1);
  if (rows[0]?.role_id) return rows[0].role_id;
  for (const name of principal.roles ?? []) {
    const id = await lookupBuiltinRoleIdByName(db, name);
    if (id) return id;
  }
  return null;
}

async function roleHasPermission(
  db: Executor,
  roleId: string,
  permissionId: string,
): Promise<boolean> {
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
  db: Executor,
  tenantId: string,
  userId: string,
  permissionId: string,
): Promise<boolean> {
  const rows = await db
    .select({ group_id: groupMembers.group_id })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.group_id))
    .innerJoin(users, eq(users.id, groupMembers.user_id))
    .innerJoin(groupRoleAssignments, eq(groupRoleAssignments.group_id, groupMembers.group_id))
    .innerJoin(rolesTable, eq(rolesTable.id, groupRoleAssignments.role_id))
    .innerJoin(rolePermissions, eq(rolePermissions.role_id, groupRoleAssignments.role_id))
    .where(
      and(
        eq(groups.tenant_id, tenantId),
        eq(users.tenant_id, tenantId),
        or(isNull(rolesTable.tenant_id), eq(rolesTable.tenant_id, tenantId)),
        eq(groupMembers.user_id, userId),
        eq(rolePermissions.permission_id, permissionId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

async function userGroupIds(db: Executor, tenantId: string, userId: string): Promise<string[]> {
  const rows = await db
    .select({ group_id: groupMembers.group_id })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.group_id))
    .innerJoin(users, eq(users.id, groupMembers.user_id))
    .where(
      and(eq(groups.tenant_id, tenantId), eq(users.tenant_id, tenantId), eq(users.id, userId)),
    );
  return rows.map((r) => r.group_id);
}

async function hasResourceGrant(
  db: Executor,
  check: PermissionCheck,
  permissionId: string,
): Promise<boolean> {
  if (!check.resource) return false;
  if (!isUuid(check.resource.id)) return false;

  const subjectClauses = [
    and(
      eq(resourceGrants.subject_type, check.principal.kind),
      eq(resourceGrants.subject_id, check.principal.id),
    ),
  ];
  if (check.principal.kind === "user") {
    const groupIds = await userGroupIds(db, check.tenant_id, check.principal.id);
    if (groupIds.length > 0) {
      subjectClauses.push(
        and(eq(resourceGrants.subject_type, "group"), inArray(resourceGrants.subject_id, groupIds)),
      );
    }
  }

  const rows = await db
    .select({ id: resourceGrants.id })
    .from(resourceGrants)
    .where(
      and(
        eq(resourceGrants.tenant_id, check.tenant_id),
        or(...subjectClauses),
        eq(resourceGrants.resource_type, check.resource.type),
        eq(resourceGrants.resource_id, check.resource.id),
        eq(resourceGrants.permission_id, permissionId),
        or(isNull(resourceGrants.expires_at), gt(resourceGrants.expires_at, new Date(now()))),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export function hasBuiltinAdminRole(principal: ResolvedPrincipal): boolean {
  return isBuiltinAdmin(principal.roles);
}

const rbacCtx = (check: PermissionCheck) => ({
  permission: check.permission,
  principal_kind: check.principal.kind,
  principal_id: check.principal.id,
  resource_type: check.resource?.type,
  resource_id: check.resource?.id,
});

function ceilingDeny(check: PermissionCheck, cause: string): Decision {
  const decision = credentialCeilingDecision(coreRequest(check), {
    credential_ceiling_cause: cause,
  });
  if (!decision) throw new Error("credential ceiling decision missing cause");
  const reason = decision.reason!;
  recordMetric("deny", check.permission, "credential_ceiling");
  emitDeny(check, reason, "credential_ceiling");
  return decision;
}

function coreRequest(check: PermissionCheck) {
  return {
    permission: check.permission,
    ...(check.resource ? { resource: check.resource } : {}),
    portal_token: check.principal.provider === "portal_token",
    ...(check.principal.allowed_workflows !== undefined
      ? { portal_workflow_allowlist: check.principal.allowed_workflows }
      : {}),
  } as const;
}

function coreDecision(check: PermissionCheck, facts: Partial<PermissionFacts>): Decision {
  return evaluatePermission(coreRequest(check), {
    operator_allowed: true,
    builtin_admin: false,
    permission_known: true,
    resource_grant: false,
    group_grant: false,
    role_grant: false,
    ...facts,
  });
}

export const PRODUCT_PERMISSIONS: ReadonlySet<string> = new Set([
  "workflow:run",
  "execution:read",
  "execution:abort",
]);

function credentialCeiling(check: PermissionCheck): Decision | null {
  const { principal } = check;
  if (principal.provider === "portal_token") return null;
  const ceiling = ceilingScopes(principal.scopes);
  const cause = credentialCeilingCause(coreRequest(check), {
    product_limited: Boolean(principal.product_id),
    product_permission_allowed: PRODUCT_PERMISSIONS.has(check.permission),
    scope_limited: ceiling.length > 0,
    scope_allows_permission: ceiling.includes(check.permission),
    ...(principal.allowed_connectors !== undefined
      ? { connector_allowlist: principal.allowed_connectors }
      : {}),
    ...(principal.allowed_workflows !== undefined
      ? { workflow_allowlist: principal.allowed_workflows }
      : {}),
  });
  return cause ? ceilingDeny(check, cause) : null;
}

export const OPERATOR_ONLY_CAUSE = "operator_only";

function operatorDeny(check: PermissionCheck): Decision {
  const decision = coreDecision(check, { operator_allowed: false });
  const reason = decision.reason!;
  recordMetric("deny", check.permission, "operator_boundary");
  emitDeny(check, reason, "operator_boundary");
  return decision;
}

export async function can(db: Executor, check: PermissionCheck): Promise<Decision> {
  const ceiling = credentialCeiling(check);
  if (ceiling) return ceiling;

  if (isOperatorPermission(check.permission) && !(await isOperatorPrincipal(db, check.principal))) {
    return operatorDeny(check);
  }

  if (hasBuiltinAdminRole(check.principal)) {
    recordMetric("allow", check.permission, "builtin_admin");
    log.rbac.checked({ allow: true, source: "builtin_admin", ...rbacCtx(check) });
    return coreDecision(check, { builtin_admin: true });
  }

  const permissionId = await lookupPermissionId(db, check.permission);
  if (!permissionId) {
    recordMetric("deny", check.permission, "unknown_permission");
    emitDeny(check, `permission_unknown:${check.permission}`, "unknown_permission");
    return coreDecision(check, { permission_known: false });
  }

  const isPortalToken = check.principal.provider === "portal_token";

  if (!isPortalToken && check.resource) {
    const granted = await hasResourceGrant(db, check, permissionId);
    if (granted) {
      recordMetric("allow", check.permission, "resource_grant");
      log.rbac.checked({ allow: true, source: "resource_grant", ...rbacCtx(check) });
      return coreDecision(check, { resource_grant: true });
    }
  }

  if (!isPortalToken && check.principal.kind === "user") {
    const granted = await groupGrantsPermission(
      db,
      check.tenant_id,
      check.principal.id,
      permissionId,
    );
    if (granted) {
      recordMetric("allow", check.permission, "group");
      log.rbac.checked({ allow: true, source: "group", ...rbacCtx(check) });
      return coreDecision(check, { group_grant: true });
    }
  }

  if (!isPortalToken) {
    const roleId = await principalRoleId(db, check.principal);
    if (roleId) {
      const granted = await roleHasPermission(db, roleId, permissionId);
      if (granted) {
        recordMetric("allow", check.permission, "role");
        log.rbac.checked({ allow: true, source: "role", ...rbacCtx(check) });
        return coreDecision(check, { role_grant: true });
      }
    }
  }

  if (matchesPortalTokenAllowlist(coreRequest(check))) {
    recordMetric("allow", check.permission, "portal_token_allowlist");
    log.rbac.checked({ allow: true, source: "portal_token_allowlist", ...rbacCtx(check) });
    return coreDecision(check, {});
  }

  recordMetric("deny", check.permission, "none");
  const denial = coreDecision(check, {});
  const reason = denial.reason!;
  emitDeny(check, reason, "none");
  return denial;
}

interface ResourceAccess {
  tenantWide: Decision;
  allows(id: string): boolean;
  any: boolean;
}

export async function resourceAccess(
  db: Executor,
  check: {
    tenant_id: string;
    principal: ResolvedPrincipal;
    permission: string;
    resource_type: string;
    quiet?: boolean;
  },
): Promise<ResourceAccess> {
  const { principal, permission, resource_type } = check;
  const tenantWide = await can(db, {
    tenant_id: check.tenant_id,
    principal,
    permission,
    ...(check.quiet ? { quiet: true } : {}),
  });
  const isPortalToken = principal.provider === "portal_token";
  const project = (granted_ids: readonly string[]): ResourceAccess =>
    evaluateResourceAccess(tenantWide, {
      portal_token: isPortalToken,
      permission,
      resource_type,
      granted_ids,
      ...(principal.allowed_workflows !== undefined
        ? { workflow_allowlist: principal.allowed_workflows }
        : {}),
      ...(principal.allowed_connectors !== undefined
        ? { connector_allowlist: principal.allowed_connectors }
        : {}),
    });
  if (
    tenantWide.source === "credential_ceiling" ||
    tenantWide.source === "operator_boundary" ||
    tenantWide.allow
  )
    return project([]);
  const granted = new Set<string>();
  if (!isPortalToken) {
    const permissionId = await lookupPermissionId(db, permission);
    if (permissionId) {
      const subjectClauses = [
        and(
          eq(resourceGrants.subject_type, principal.kind),
          eq(resourceGrants.subject_id, principal.id),
        ),
      ];
      if (principal.kind === "user") {
        const groupIds = await userGroupIds(db, check.tenant_id, principal.id);
        if (groupIds.length > 0) {
          subjectClauses.push(
            and(
              eq(resourceGrants.subject_type, "group"),
              inArray(resourceGrants.subject_id, groupIds),
            ),
          );
        }
      }
      const rows = await db
        .select({ id: resourceGrants.resource_id })
        .from(resourceGrants)
        .where(
          and(
            eq(resourceGrants.tenant_id, check.tenant_id),
            or(...subjectClauses),
            eq(resourceGrants.resource_type, resource_type),
            eq(resourceGrants.permission_id, permissionId),
            or(isNull(resourceGrants.expires_at), gt(resourceGrants.expires_at, new Date(now()))),
          ),
        );
      for (const row of rows) granted.add(row.id);
    }
  }
  return project([...granted]);
}

export async function catalogVisibility(
  db: Executor,
  principal: ResolvedPrincipal,
  permission: "workflow:read" | "connector:read",
  resource_type: "workflow" | "connector",
): Promise<((id: string) => boolean) | null> {
  const access = await resourceAccess(db, {
    tenant_id: principal.tenant_id,
    principal,
    permission,
    resource_type,
    quiet: true,
  });
  return access.any ? access.allows : null;
}

function emitDeny(check: PermissionCheck, reason: string, source: string): void {
  if (check.quiet) {
    log.rbac.checked({ allow: false, source, reason, ...rbacCtx(check) });
    return;
  }
  log.rbac.denied({ source, reason, ...rbacCtx(check) });
}

export async function principalHolds(
  db: Executor,
  principal: ResolvedPrincipal,
  permission: string,
): Promise<boolean> {
  const decision = await can(db, {
    tenant_id: principal.tenant_id,
    principal,
    permission,
    quiet: true,
  });
  return decision.allow;
}

export async function assertCan(db: Executor, check: PermissionCheck): Promise<Decision> {
  const d = await can(db, check);
  if (!d.allow) {
    const err = new Error(d.reason ?? "permission_denied");
    (err as { rbac_decision?: Decision }).rbac_decision = d;
    throw err;
  }
  return d;
}

export async function connectorAccessLevel(
  db: Executor,
  principal: ResolvedPrincipal,
  connectorId: string,
  tenantId: string,
): Promise<ConnectorAccessLevel> {
  const base = {
    tenant_id: tenantId,
    principal,
    resource: { type: "connector", id: connectorId },
    quiet: true,
  } as const;
  const [read, write] = await Promise.all([
    can(db, { ...base, permission: "connector:read" }),
    can(db, { ...base, permission: "connector:write" }),
  ]);
  return deriveConnectorAccessLevel(read, write);
}

export { rolesTable as rbacRoles };
