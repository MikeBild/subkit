// Centralized RBAC permission evaluator.
//
// `can(db, check)` returns a `Decision` answering whether the
// principal holds `permission` on the target resource. Callers use
// the returned `Decision.allow` + `Decision.reason` to either let the
// request through or raise `ForbiddenError`.
//
// Evaluation order (first match wins):
//   0. Credential ceiling — api-key scopes / allowed_connectors /
//      allowed_workflows. A deny here precedes EVERY positive rule
//      (including the admin short-circuit) so a deliberately narrow
//      credential narrows even an admin → `credential_ceiling`.
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

import { and, eq, gt, inArray, isNull, or } from "drizzle-orm";

import { isCeilingScope, WILDCARD_SCOPE } from "../auth/scopes.ts";
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
import { now } from "../utils/clock.ts";

export type DecisionSource =
  | "builtin_admin"
  | "resource_grant"
  | "group"
  | "role"
  | "portal_token_allowlist"
  // A deny produced by the credential ceiling — the api-key scopes /
  // allowed_connectors / allowed_workflows narrowed the request before
  // any positive rule (including the admin short-circuit) could apply.
  | "credential_ceiling";

/** Connector authorization collapsed to a single level, mirroring the
 *  none / read-only / read-write framing. Computed by
 *  `connectorAccessLevel` from the same `can()` the engine enforces. */
export type ConnectorAccessLevel = "none" | "read-only" | "read-write";

/**
 * Structured, surface-agnostic denial detail used to render an actionable
 * message on REST / MCP / CLI (e.g. "you have read-only access to connector
 * X; this needs read-write"). Present only on denies that have a knowable
 * remedy — not on `permission_unknown` (a config error, not a grant gap).
 */
export interface DenyDetail {
  /** The permission the caller lacked. */
  required: string;
  /** The resource the check targeted, if any. */
  resource?: { type: string; id: string };
  /** Machine-readable cause, e.g. `credential_ceiling:scope_not_granted`
   *  or `no_matching_grant`. */
  cause: string;
}

export interface PermissionCheck {
  tenant_id: string;
  principal: ResolvedPrincipal;
  permission: string;
  resource?: { type: string; id: string };
  /**
   * When set, a DENY decision is logged at DEBUG (`rbac.checked`)
   * instead of WARN (`rbac.denied`). Use ONLY for probe-style checks
   * where a "no" is an expected, routine outcome — e.g. enumerating
   * which of several scopes a role holds. A genuine enforcement check
   * (gating an actual request) must NOT set this: an unexpected deny
   * there is operator-actionable and belongs at WARN. The deny metric
   * counter fires regardless of `quiet`.
   */
  quiet?: boolean;
}

export interface Decision {
  allow: boolean;
  reason?: string;
  source?: DecisionSource;
  /** Actionable denial detail (Stream 2). Set only on denies. */
  detail?: DenyDetail;
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

async function userGroupIds(db: Db, userId: string): Promise<string[]> {
  // tenant-filter:exempt — group_members has no tenant_id column; a user's
  // group memberships are tenant-scoped transitively (group_members.group_id
  // → groups.tenant_id, and a user only joins groups in its own tenant). The
  // resulting grant lookup IS tenant-filtered. Mirrors groupGrantsPermission.
  const rows = await db
    .select({ group_id: groupMembers.group_id })
    .from(groupMembers)
    .where(eq(groupMembers.user_id, userId));
  return rows.map((r) => r.group_id);
}

async function hasResourceGrant(
  db: Db,
  check: PermissionCheck,
  permissionId: string,
): Promise<boolean> {
  if (!check.resource) return false;

  // A grant resolves if its subject is the principal itself OR — for a
  // user — any group the principal belongs to. Matching only
  // `subject_type === principal.kind` (the old behaviour) made every
  // `subject_type='group'` grant invisible, so a group-scoped grant
  // silently never applied.
  const subjectClauses = [
    and(
      eq(resourceGrants.subject_type, check.principal.kind),
      eq(resourceGrants.subject_id, check.principal.id),
    ),
  ];
  if (check.principal.kind === "user") {
    const groupIds = await userGroupIds(db, check.principal.id);
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
        // Expired grants must not allow. NULL = never expires. `now()` is
        // the test-overridable clock seam, consistent with how `expires_at`
        // is written app-side (see rbac/grants.ts).
        or(isNull(resourceGrants.expires_at), gt(resourceGrants.expires_at, new Date(now()))),
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
    if (check.resource?.type !== "workflow") return false;
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

function ceilingDeny(check: PermissionCheck, cause: string): Decision {
  const reason = `credential_ceiling:${cause}`;
  recordMetric("deny", check.permission, "credential_ceiling");
  emitDeny(check, reason, "credential_ceiling");
  return {
    allow: false,
    reason,
    source: "credential_ceiling",
    detail: {
      required: check.permission,
      ...(check.resource ? { resource: check.resource } : {}),
      cause: reason,
    },
  };
}

/**
 * Credential ceiling — runs BEFORE every positive rule (including the admin
 * short-circuit). A credential whose scopes / allowed_connectors /
 * allowed_workflows are deliberately narrow must narrow even an admin-role
 * key, or the displayed scope is a lie. Returns a deny `Decision` when the
 * credential excludes the request, or `null` to continue normal evaluation.
 *
 * Portal tokens are exempt: they carry their own hard-isolation allowlist
 * enforced by `matchesPortalTokenAllowlist`, and the `isPortalToken`
 * short-circuits below already gate them. Re-checking here would only
 * duplicate that path and perturb its reason strings.
 */
function credentialCeiling(check: PermissionCheck): Decision | null {
  const { principal } = check;
  if (principal.provider === "portal_token") return null;

  // 1. scopes ceiling. Only `resource:action` scopes narrow; the `*`
  //    wildcard and the `mcp:*` mode markers do not (see auth/scopes.ts).
  //    A scope set that is *only* wildcard/markers imposes no ceiling.
  const scopes = principal.scopes;
  if (scopes && scopes.length > 0 && !scopes.includes(WILDCARD_SCOPE)) {
    const ceiling = scopes.filter(isCeilingScope);
    if (ceiling.length > 0 && !ceiling.includes(check.permission)) {
      return ceilingDeny(check, "scope_not_granted");
    }
  }

  // 2. allowed_connectors ceiling — caps connector-resource operations to
  //    the key's connector allowlist.
  const connectors = principal.allowed_connectors;
  if (
    connectors &&
    connectors !== "all" &&
    check.resource?.type === "connector" &&
    !connectors.includes(check.resource.id)
  ) {
    return ceilingDeny(check, "connector_not_in_allowlist");
  }

  // 3. allowed_workflows ceiling — caps workflow-resource operations to
  //    the key's workflow allowlist.
  const workflows = principal.allowed_workflows;
  if (
    workflows &&
    workflows !== "all" &&
    check.resource?.type === "workflow" &&
    !workflows.includes(check.resource.id)
  ) {
    return ceilingDeny(check, "workflow_not_in_allowlist");
  }

  return null;
}

export async function can(db: Db, check: PermissionCheck): Promise<Decision> {
  // 0. credential ceiling — a deliberately narrow credential narrows the
  //    request BEFORE the admin short-circuit, so the surfaced scope is the
  //    enforced scope even for an admin-role key.
  const ceiling = credentialCeiling(check);
  if (ceiling) return ceiling;

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
    emitDeny(check, `permission_unknown:${check.permission}`, "unknown_permission");
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
  emitDeny(check, reason, "none");
  return {
    allow: false,
    reason,
    detail: {
      required: check.permission,
      ...(check.resource ? { resource: check.resource } : {}),
      cause: isPortalToken ? "workflow_not_in_allowlist" : "no_matching_grant",
    },
  };
}

/**
 * Emit the structured log line for a DENY decision.
 *
 * A genuine enforcement deny (gating a real request) logs at WARN
 * (`rbac.denied`) — it is operator-actionable. A `quiet` deny logs at
 * DEBUG (`rbac.checked`) — `quiet` marks a probe-style check where a
 * "no" is the expected, routine outcome and a WARN would be pure
 * noise. The deny metric counter is bumped by the caller in BOTH
 * cases; `quiet` only changes the log level, never the metric.
 */
function emitDeny(check: PermissionCheck, reason: string, source: string): void {
  if (check.quiet) {
    log.rbac.checked({ allow: false, source, reason, ...rbacCtx(check) });
    return;
  }
  // The genuine-deny WARN path is the one forensics reads — include
  // `source` so an operator sees WHICH rule rejected the request, not
  // just that it was rejected.
  log.rbac.denied({ source, reason, ...rbacCtx(check) });
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

/**
 * Collapse a principal's connector authorization to a single level —
 * `read-write` / `read-only` / `none` — the framing shared by the denial
 * message (Stream 2), the introspection endpoint (Stream 3), and the
 * build-time warning (Stream 4). Two `can()` probes against the same
 * evaluator the engine enforces; both are `quiet` because a "no" here is a
 * routine introspection outcome, not an operator-actionable deny.
 */
export async function connectorAccessLevel(
  db: Db,
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
  if (write.allow) return "read-write";
  if (read.allow) return "read-only";
  return "none";
}

// Re-export symbols some consumers import from here.
export { permissionsTable as rbacPermissions, rolesTable as rbacRoles };
