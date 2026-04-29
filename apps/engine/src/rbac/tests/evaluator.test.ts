// RBAC evaluator unit test — exercises each decision branch against a
// real Postgres database so role_permissions + group joins + resource
// grants behave exactly like they do in production.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import {
  groupMembers,
  groupRoleAssignments,
  groups,
  permissions as permissionsTable,
  rolePermissions,
  roles as rolesTable,
  systemAccounts,
  tenants,
  users,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { can } from "../evaluator.ts";
import * as grantsSvc from "../grants.ts";

describe("rbac evaluator", () => {
  let testDb: TestDb;
  let db: Db;
  let tenantId: string;
  let adminUserId: string;
  let memberUserId: string;
  let resourceGrantUserId: string;
  let groupUserId: string;
  const workflowA = "11111111-1111-1111-1111-111111111111";
  const workflowB = "22222222-2222-2222-2222-222222222222";

  beforeAll(async () => {
    testDb = await createTestDb("rbac-evaluator");
    db = testDb.db;
    const [t] = await db
      .insert(tenants)
      .values({ slug: "rbac-ev", display_name: "rbac-ev" })
      .returning();
    if (!t) throw new Error("seed tenant");
    tenantId = t.id;

    // Look up built-in roles (seeded by createTestDb).
    const findBuiltin = async (name: string) => {
      const rows = await db
        .select({ id: rolesTable.id })
        .from(rolesTable)
        .where(and(isNull(rolesTable.tenant_id), eq(rolesTable.name, name)))
        .limit(1);
      return rows[0]?.id;
    };
    const adminRoleId = await findBuiltin("admin");
    const memberRoleId = await findBuiltin("member");
    if (!adminRoleId || !memberRoleId) throw new Error("builtin roles missing");

    const seedUser = async (email: string, roleId: string | null): Promise<string> => {
      const [row] = await db
        .insert(users)
        .values({ tenant_id: tenantId, email, role: "admin", role_id: roleId })
        .returning({ id: users.id });
      if (!row) throw new Error("seed user");
      return row.id;
    };
    adminUserId = await seedUser("admin@ev", adminRoleId);
    memberUserId = await seedUser("member@ev", memberRoleId);
    resourceGrantUserId = await seedUser("grant@ev", memberRoleId);
    groupUserId = await seedUser("group@ev", null);

    // Resource grant: user X has `audit:read` scoped to workflowA.
    // We use `audit:read` (admin-only at role level) as a sentinel
    // because members now hold `workflow:delete` via the member role
    // — pre-fix the grant on a member-role permission collapsed the
    // resource-scope vs role-scope distinction these tests pin.
    await grantsSvc.grantResource(db, {
      tenant_id: tenantId,
      subject_type: "user",
      subject_id: resourceGrantUserId,
      resource_type: "workflow",
      resource_id: workflowA,
      permission: "audit:read",
    });

    // Group path: create a group that is assigned the `admin` role
    // and add groupUserId as a member.
    const [group] = await db
      .insert(groups)
      .values({ tenant_id: tenantId, name: "ops" })
      .returning({ id: groups.id });
    if (!group) throw new Error("seed group");
    await db.insert(groupRoleAssignments).values({ group_id: group.id, role_id: adminRoleId });
    await db.insert(groupMembers).values({ group_id: group.id, user_id: groupUserId });
  });

  afterAll(async () => {
    await testDb.cleanup();
  });

  function mkPrincipal(id: string, roleName: string): ResolvedPrincipal {
    return {
      provider: "api_key",
      kind: "user",
      id,
      tenant_id: tenantId,
      roles: [roleName],
    };
  }

  test("builtin_admin short-circuits", async () => {
    const d = await can(db, {
      tenant_id: tenantId,
      principal: mkPrincipal(adminUserId, "admin"),
      permission: "workflow:delete",
    });
    expect(d.allow).toBe(true);
    expect(d.source).toBe("builtin_admin");
  });

  test("role permission grants access", async () => {
    const d = await can(db, {
      tenant_id: tenantId,
      principal: mkPrincipal(memberUserId, "member"),
      permission: "workflow:read",
    });
    expect(d.allow).toBe(true);
    expect(d.source).toBe("role");
  });

  test("role denies when permission not in role_permissions", async () => {
    // `audit:read` is admin-only — `workflow:delete` was previously
    // used here as the "member doesn't have it" sentinel, but
    // members now CAN delete workflows they own (session 0aed284f
    // fix). Use a permission that's still admin-only.
    const d = await can(db, {
      tenant_id: tenantId,
      principal: mkPrincipal(memberUserId, "member"),
      permission: "audit:read",
    });
    expect(d.allow).toBe(false);
    expect(d.reason).toContain("permission_denied");
  });

  test("resource_grant path grants access on target", async () => {
    const d = await can(db, {
      tenant_id: tenantId,
      principal: mkPrincipal(resourceGrantUserId, "member"),
      permission: "audit:read",
      resource: { type: "workflow", id: workflowA },
    });
    expect(d.allow).toBe(true);
    expect(d.source).toBe("resource_grant");
  });

  test("resource_grant does not leak to other resources", async () => {
    const d = await can(db, {
      tenant_id: tenantId,
      principal: mkPrincipal(resourceGrantUserId, "member"),
      permission: "audit:read",
      resource: { type: "workflow", id: workflowB },
    });
    expect(d.allow).toBe(false);
  });

  test("group membership grants access via admin role assignment", async () => {
    const d = await can(db, {
      tenant_id: tenantId,
      principal: mkPrincipal(groupUserId, "member"),
      permission: "workflow:delete",
    });
    expect(d.allow).toBe(true);
    expect(d.source).toBe("group");
  });

  test("portal_token allowlist allows workflow:run when included", async () => {
    const principal: ResolvedPrincipal = {
      provider: "portal_token",
      kind: "user",
      id: resourceGrantUserId,
      tenant_id: tenantId,
      roles: ["enduser"],
      allowed_workflows: [workflowB],
    };
    const d = await can(db, {
      tenant_id: tenantId,
      principal,
      permission: "workflow:run",
      resource: { type: "workflow", id: workflowB },
    });
    expect(d.allow).toBe(true);
    expect(d.source).toBe("portal_token_allowlist");
  });

  test("portal_token outside allowlist is denied", async () => {
    const principal: ResolvedPrincipal = {
      provider: "portal_token",
      kind: "user",
      id: resourceGrantUserId,
      tenant_id: tenantId,
      roles: ["enduser"],
      allowed_workflows: [workflowB],
    };
    const d = await can(db, {
      tenant_id: tenantId,
      principal,
      permission: "workflow:run",
      resource: { type: "workflow", id: workflowA },
    });
    expect(d.allow).toBe(false);
  });

  test("unknown permission is denied", async () => {
    const d = await can(db, {
      tenant_id: tenantId,
      principal: mkPrincipal(memberUserId, "member"),
      permission: "something:nonexistent",
    });
    expect(d.allow).toBe(false);
    expect(d.reason).toContain("permission_unknown");
  });

  // Suppress unused imports used to pin types to Db barrel.
  void permissionsTable;
  void rolePermissions;
  void systemAccounts;
  void workflowA;
});
