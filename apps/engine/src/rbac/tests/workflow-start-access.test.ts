import { beforeAll, describe, expect, spyOn, test } from "bun:test";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { permissions, resourceGrants, roles } from "../../db/schema/index.ts";
import { logger } from "../../logging/logger.ts";
import { grantResource, revokeResource } from "../grants.ts";
import { workflowStartAccess } from "../workflow-start-access.ts";
import {
  AT,
  addGroup,
  addSystemAccount,
  addTenant,
  addUser,
  builtinRole,
  customRole,
  systemPrincipal,
  useAccessDb,
  userPrincipal,
} from "./workflow-start-access-fixtures.ts";

const h = useAccessDb("wf_start_access", 20_261_106);

const WF_A = "a0000000-0000-4000-8000-00000000000a";
const WF_B = "b0000000-0000-4000-8000-00000000000b";

const STATIC_TAIL = {
  external: { authentication_required: true, credential_restrictions_apply: true },
  without_approval: "held_preview_only",
} as const;

let tenantA: string;
let tenantB: string;
let adminA: string;
let auditorA: string;
let memberA: string;
let noneA: string;
let grantedA: string;
let groupGrantA: string;
let groupRoleA: string;
let expiringA: string;
let laterA: string;
let systemGrantA: string;
let groupA: string;
let adminB: string;
let userB: string;
let runnerRoleA: string;
let runnerRoleB: string;

async function runGrant(
  tenant_id: string,
  subject_type: "user" | "system_account" | "group",
  subject_id: string,
  resource_id: string,
  expires_at: Date | null = null,
  permission = "workflow:run",
) {
  return grantResource(h.db, {
    tenant_id,
    subject_type,
    subject_id,
    resource_type: "workflow",
    resource_id,
    permission,
    expires_at,
  });
}

async function startRolesVisibleTo(tenantId: string) {
  const rows = await h.db
    .selectDistinct({ id: roles.id, name: roles.name })
    .from(roles)
    .where(
      and(
        or(isNull(roles.tenant_id), eq(roles.tenant_id, tenantId)),
        inArray(roles.name, ["admin", "enduser", "member", "portal_token_user", "runner"]),
      ),
    );
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

beforeAll(async () => {
  tenantA = await addTenant(h, "start-a");
  tenantB = await addTenant(h, "start-b");
  const admin = await builtinRole(h, "admin");
  const member = await builtinRole(h, "member");
  const emptyA = await customRole(h, tenantA, "empty", []);
  const emptyB = await customRole(h, tenantB, "empty", []);
  runnerRoleA = await customRole(h, tenantA, "runner", ["workflow:run"]);
  runnerRoleB = await customRole(h, tenantB, "b-runner", ["workflow:run"]);
  const auditorRole = await customRole(h, tenantA, "auditor", ["rbac:read"]);

  adminA = await addUser(h, tenantA, "admin@a", admin);
  auditorA = await addUser(h, tenantA, "auditor@a", auditorRole);
  memberA = await addUser(h, tenantA, "member@a", member);
  noneA = await addUser(h, tenantA, "none@a", emptyA);
  grantedA = await addUser(h, tenantA, "granted@a", emptyA);
  groupGrantA = await addUser(h, tenantA, "group-grant@a", emptyA);
  groupRoleA = await addUser(h, tenantA, "group-role@a", emptyA);
  expiringA = await addUser(h, tenantA, "expiring@a", emptyA);
  laterA = await addUser(h, tenantA, "later@a", emptyA);
  systemGrantA = await addSystemAccount(h, tenantA, "bot-a", emptyA);
  groupA = await addGroup(h, tenantA, "starters", [], [groupGrantA]);
  await addGroup(h, tenantA, "runners", [runnerRoleA], [groupRoleA]);
  adminB = await addUser(h, tenantB, "admin@b", admin);
  userB = await addUser(h, tenantB, "user@b", emptyB);

  await runGrant(tenantA, "user", grantedA, WF_A);
  await runGrant(tenantA, "group", groupA, WF_A);
  await runGrant(tenantA, "system_account", systemGrantA, WF_A);
  await runGrant(tenantA, "user", expiringA, WF_A, AT);
  await runGrant(tenantA, "user", laterA, WF_A, new Date(AT.getTime() + 1));
  await runGrant(tenantA, "user", noneA, WF_A, null, "workflow:read");
  await runGrant(tenantA, "user", memberA, WF_B);
  await runGrant(tenantB, "user", userB, WF_A);
  const [run] = await h.db
    .select({ id: permissions.id })
    .from(permissions)
    .where(eq(permissions.name, "workflow:run"));
  if (!run) throw new Error("workflow:run missing");
  await h.db.insert(resourceGrants).values({
    tenant_id: tenantA,
    subject_type: "api_key",
    subject_id: h.nextId(),
    resource_type: "workflow",
    resource_id: WF_A,
    permission_id: run.id,
  });
});

describe("workflowStartAccess rules view", () => {
  test("an admin sees every role and live grant that can start the workflow", async () => {
    const result = await workflowStartAccess(
      h.db,
      userPrincipal(tenantA, adminA, ["admin"]),
      WF_A,
      AT,
    );
    const grantRows: Array<{
      subject_type: "user" | "system_account" | "group";
      subject_id: string;
      expires_at: string | null;
    }> = [
      { subject_type: "group", subject_id: groupA, expires_at: null },
      { subject_type: "system_account", subject_id: systemGrantA, expires_at: null },
      { subject_type: "user", subject_id: grantedA, expires_at: null },
      {
        subject_type: "user",
        subject_id: laterA,
        expires_at: new Date(AT.getTime() + 1).toISOString(),
      },
    ];
    const expectedGrants = grantRows.sort(
      (a, b) =>
        a.subject_type.localeCompare(b.subject_type) || a.subject_id.localeCompare(b.subject_id),
    );
    expect(result).toEqual({
      permission: "workflow:run",
      caller: { allowed: true, source: "builtin_admin", reason: null },
      visibility: { rules: true },
      rules: { roles: await startRolesVisibleTo(tenantA), grants: expectedGrants },
      ...STATIC_TAIL,
    });
  });

  test("the admin role is listed once although it holds many permissions", async () => {
    const result = await workflowStartAccess(
      h.db,
      userPrincipal(tenantA, adminA, ["admin"]),
      WF_A,
      AT,
    );
    expect(result.rules?.roles.filter((role) => role.name === "admin")).toHaveLength(1);
    expect(result.rules?.roles.map((role) => role.name)).not.toContain("auditor");
  });

  test("a grant expiring exactly at the evaluation time is gone, one a millisecond later stays", async () => {
    const principal = userPrincipal(tenantA, adminA, ["admin"]);
    const atBoundary = await workflowStartAccess(h.db, principal, WF_A, AT);
    const subjects = atBoundary.rules?.grants.map((grant) => grant.subject_id);
    expect(subjects).not.toContain(expiringA);
    expect(subjects).toContain(laterA);
    const after = await workflowStartAccess(h.db, principal, WF_A, new Date(AT.getTime() + 1));
    expect(after.rules?.grants.map((grant) => grant.subject_id)).not.toContain(laterA);
  });

  test("grants for another permission, another workflow or an unknown subject type are not listed", async () => {
    const result = await workflowStartAccess(
      h.db,
      userPrincipal(tenantA, adminA, ["admin"]),
      WF_A,
      AT,
    );
    const subjects = result.rules?.grants.map((grant) => grant.subject_id) ?? [];
    expect(subjects).not.toContain(noneA);
    expect(subjects).not.toContain(memberA);
    expect(result.rules?.grants.map((grant) => grant.subject_type).sort()).toEqual([
      "group",
      "system_account",
      "user",
      "user",
    ]);
  });

  test("another tenant sees only its own roles and grants for the same workflow id", async () => {
    const result = await workflowStartAccess(
      h.db,
      userPrincipal(tenantB, adminB, ["admin"]),
      WF_A,
      AT,
    );
    const roleIds = result.rules?.roles.map((role) => role.id) ?? [];
    expect(roleIds).toContain(runnerRoleB);
    expect(roleIds).not.toContain(runnerRoleA);
    expect(result.rules?.grants).toEqual([
      { subject_type: "user", subject_id: userB, expires_at: null },
    ]);
  });

  test("a revoked grant no longer starts the workflow nor appears in the rules", async () => {
    const grant = await runGrant(tenantA, "user", noneA, WF_B);
    const admin = userPrincipal(tenantA, adminA, ["admin"]);
    const before = await workflowStartAccess(
      h.db,
      userPrincipal(tenantA, noneA, ["empty"]),
      WF_B,
      AT,
    );
    expect(before.caller).toEqual({ allowed: true, source: "resource_grant", reason: null });
    expect(
      (await workflowStartAccess(h.db, admin, WF_B, AT)).rules?.grants.map((g) => g.subject_id),
    ).toContain(noneA);
    expect(await revokeResource(h.db, tenantA, grant.id)).toBe(true);
    const after = await workflowStartAccess(
      h.db,
      userPrincipal(tenantA, noneA, ["empty"]),
      WF_B,
      AT,
    );
    expect(after.caller).toEqual({
      allowed: false,
      source: null,
      reason: "permission_denied:workflow:run",
    });
    expect(
      (await workflowStartAccess(h.db, admin, WF_B, AT)).rules?.grants.map((g) => g.subject_id),
    ).not.toContain(noneA);
  });
});

describe("workflowStartAccess caller decision", () => {
  test("a non-admin who may read RBAC sees the rules but may not start", async () => {
    const result = await workflowStartAccess(
      h.db,
      userPrincipal(tenantA, auditorA, ["auditor"]),
      WF_A,
      AT,
    );
    expect(result.caller).toEqual({
      allowed: false,
      source: null,
      reason: "permission_denied:workflow:run",
    });
    expect(result.visibility).toEqual({ rules: true });
    expect(result.rules?.grants.map((grant) => grant.subject_id)).toContain(grantedA);
  });

  test("a member may start through its role but is not shown the rules", async () => {
    const result = await workflowStartAccess(
      h.db,
      userPrincipal(tenantA, memberA, ["member"]),
      WF_A,
      AT,
    );
    expect(result).toEqual({
      permission: "workflow:run",
      caller: { allowed: true, source: "role", reason: null },
      visibility: { rules: false },
      ...STATIC_TAIL,
    });
    expect("rules" in result).toBe(false);
  });

  test("a user without any matching grant is denied with the permission reason", async () => {
    const result = await workflowStartAccess(
      h.db,
      userPrincipal(tenantA, noneA, ["empty"]),
      WF_A,
      AT,
    );
    expect(result.caller).toEqual({
      allowed: false,
      source: null,
      reason: "permission_denied:workflow:run",
    });
  });

  test("a user grant starts only the granted workflow", async () => {
    const principal = userPrincipal(tenantA, grantedA, ["empty"]);
    expect((await workflowStartAccess(h.db, principal, WF_A, AT)).caller).toEqual({
      allowed: true,
      source: "resource_grant",
      reason: null,
    });
    expect((await workflowStartAccess(h.db, principal, WF_B, AT)).caller.allowed).toBe(false);
  });

  test("a group grant lets its member start that workflow and nothing else", async () => {
    const principal = userPrincipal(tenantA, groupGrantA, ["empty"]);
    expect((await workflowStartAccess(h.db, principal, WF_A, AT)).caller.source).toBe(
      "resource_grant",
    );
    expect((await workflowStartAccess(h.db, principal, WF_B, AT)).caller.allowed).toBe(false);
  });

  test("a group role lets its member start any workflow", async () => {
    const principal = userPrincipal(tenantA, groupRoleA, ["empty"]);
    expect((await workflowStartAccess(h.db, principal, WF_B, AT)).caller).toEqual({
      allowed: true,
      source: "group",
      reason: null,
    });
  });

  test("a system account grant starts only the granted workflow", async () => {
    const principal = systemPrincipal(tenantA, systemGrantA, ["empty"]);
    expect((await workflowStartAccess(h.db, principal, WF_A, AT)).caller.source).toBe(
      "resource_grant",
    );
    expect((await workflowStartAccess(h.db, principal, WF_B, AT)).caller.allowed).toBe(false);
  });

  test("a grant expired at the evaluation clock does not start the workflow", async () => {
    const result = await workflowStartAccess(
      h.db,
      userPrincipal(tenantA, expiringA, ["empty"]),
      WF_A,
      AT,
    );
    expect(result.caller.allowed).toBe(false);
    const later = await workflowStartAccess(
      h.db,
      userPrincipal(tenantA, laterA, ["empty"]),
      WF_A,
      AT,
    );
    expect(later.caller.allowed).toBe(true);
  });

  test("another tenant's grant on the same workflow id does not reach this tenant's user", async () => {
    const result = await workflowStartAccess(
      h.db,
      userPrincipal(tenantA, userB, ["empty"]),
      WF_A,
      AT,
    );
    expect(result.caller.allowed).toBe(false);
  });

  test("a product caller may start but never sees the rules, even with the admin role", async () => {
    const result = await workflowStartAccess(
      h.db,
      userPrincipal(tenantA, adminA, ["admin"], { product_id: "prod-1" }),
      WF_A,
      AT,
    );
    expect(result.caller).toEqual({ allowed: true, source: "builtin_admin", reason: null });
    expect(result.visibility).toEqual({ rules: false });
    expect("rules" in result).toBe(false);
  });

  test("a scope-limited admin key is capped to its scope and sees no rules", async () => {
    const result = await workflowStartAccess(
      h.db,
      userPrincipal(tenantA, adminA, ["admin"], { scopes: ["workflow:run"] }),
      WF_A,
      AT,
    );
    expect(result.caller.allowed).toBe(true);
    expect(result.visibility.rules).toBe(false);
  });

  test("a workflow allowlist that excludes the workflow denies with the ceiling reason", async () => {
    const result = await workflowStartAccess(
      h.db,
      userPrincipal(tenantA, adminA, ["admin"], { allowed_workflows: [WF_B] }),
      WF_A,
      AT,
    );
    expect(result.caller).toEqual({
      allowed: false,
      source: "credential_ceiling",
      reason: "credential_ceiling:workflow_not_in_allowlist",
    });
  });

  test("a portal token starts allowlisted workflows only and never sees the rules", async () => {
    const portal = (allowed: string[]) =>
      userPrincipal(tenantA, adminA, ["admin"], {
        provider: "portal_token",
        allowed_workflows: allowed,
      });
    const inList = await workflowStartAccess(h.db, portal([WF_A]), WF_A, AT);
    expect(inList.caller).toEqual({ allowed: true, source: "builtin_admin", reason: null });
    const plain = userPrincipal(tenantA, noneA, [], {
      provider: "portal_token",
      allowed_workflows: [WF_A],
    });
    expect((await workflowStartAccess(h.db, plain, WF_A, AT)).caller).toEqual({
      allowed: true,
      source: "portal_token_allowlist",
      reason: null,
    });
    const outside = await workflowStartAccess(h.db, plain, WF_B, AT);
    expect(outside.caller).toEqual({
      allowed: false,
      source: null,
      reason: "workflow_not_in_allowlist",
    });
    expect(outside.visibility.rules).toBe(false);
  });

  test("the start check denies quietly without a WARN log", async () => {
    const warn = spyOn(logger, "warn");
    try {
      await workflowStartAccess(h.db, userPrincipal(tenantA, noneA, ["empty"]), WF_A, AT);
      const denied = warn.mock.calls.filter(
        (call) => (call[0] as { action?: string } | undefined)?.action === "denied",
      );
      expect(denied).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });
});
