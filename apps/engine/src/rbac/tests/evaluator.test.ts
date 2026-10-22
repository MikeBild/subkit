import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
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
import { logger } from "../../logging/logger.ts";
import { emptyRoleId } from "../../test-helpers/roles.ts";
import { now } from "../../utils/clock.ts";
import { can, connectorAccessLevel } from "../evaluator.ts";
import * as grantsSvc from "../grants.ts";

describe("rbac evaluator", () => {
  let testDb: TestDb;
  let db: Db;
  let tenantId: string;
  let adminUserId: string;
  let memberUserId: string;
  let resourceGrantUserId: string;
  let groupUserId: string;
  let noRoleUserId: string;
  let groupGrantUserId: string;
  let expiryUserId: string;
  const workflowA = "11111111-1111-1111-1111-111111111111";
  const workflowB = "22222222-2222-2222-2222-222222222222";
  const workflowFuture = "66666666-6666-6666-6666-666666666666";
  const connectorReadId = "33333333-3333-3333-3333-333333333333";
  const connectorRWId = "44444444-4444-4444-4444-444444444444";
  const connectorNoneId = "55555555-5555-5555-5555-555555555555";

  beforeAll(async () => {
    testDb = await createTestDb("rbac-evaluator");
    db = testDb.db;
    const [t] = await db
      .insert(tenants)
      .values({ slug: "rbac-ev", display_name: "rbac-ev" })
      .returning();
    if (!t) throw new Error("seed tenant");
    tenantId = t.id;

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

    const noPermissionsRoleId = await emptyRoleId(db, tenantId);
    const seedUser = async (email: string, roleId: string | null): Promise<string> => {
      const [row] = await db
        .insert(users)
        .values({ tenant_id: tenantId, email, role_id: roleId ?? noPermissionsRoleId })
        .returning({ id: users.id });
      if (!row) throw new Error("seed user");
      return row.id;
    };
    adminUserId = await seedUser("admin@ev", adminRoleId);
    memberUserId = await seedUser("member@ev", memberRoleId);
    resourceGrantUserId = await seedUser("grant@ev", memberRoleId);
    groupUserId = await seedUser("group@ev", null);

    await grantsSvc.grantResource(db, {
      tenant_id: tenantId,
      subject_type: "user",
      subject_id: resourceGrantUserId,
      resource_type: "workflow",
      resource_id: workflowA,
      permission: "audit:read",
    });

    const [group] = await db
      .insert(groups)
      .values({ tenant_id: tenantId, name: "ops" })
      .returning({ id: groups.id });
    if (!group) throw new Error("seed group");
    await db.insert(groupRoleAssignments).values({ group_id: group.id, role_id: adminRoleId });
    await db.insert(groupMembers).values({ group_id: group.id, user_id: groupUserId });

    noRoleUserId = await seedUser("norole@ev", null);
    groupGrantUserId = await seedUser("ggrant@ev", null);
    expiryUserId = await seedUser("expiry@ev", null);

    const [grantGroup] = await db
      .insert(groups)
      .values({ tenant_id: tenantId, name: "granted-grp" })
      .returning({ id: groups.id });
    if (!grantGroup) throw new Error("seed grant group");
    await db.insert(groupMembers).values({ group_id: grantGroup.id, user_id: groupGrantUserId });
    await grantsSvc.grantResource(db, {
      tenant_id: tenantId,
      subject_type: "group",
      subject_id: grantGroup.id,
      resource_type: "workflow",
      resource_id: workflowA,
      permission: "audit:read",
    });
    await grantsSvc.grantResource(db, {
      tenant_id: tenantId,
      subject_type: "group",
      subject_id: grantGroup.id,
      resource_type: "workflow",
      resource_id: workflowB,
      permission: "audit:read",
      expires_at: new Date(now() - 60_000),
    });

    await grantsSvc.grantResource(db, {
      tenant_id: tenantId,
      subject_type: "user",
      subject_id: expiryUserId,
      resource_type: "workflow",
      resource_id: workflowB,
      permission: "audit:read",
      expires_at: new Date(now() - 60_000),
    });
    await grantsSvc.grantResource(db, {
      tenant_id: tenantId,
      subject_type: "user",
      subject_id: expiryUserId,
      resource_type: "workflow",
      resource_id: workflowFuture,
      permission: "audit:read",
      expires_at: new Date(now() + 60_000),
    });

    await grantsSvc.grantResource(db, {
      tenant_id: tenantId,
      subject_type: "user",
      subject_id: noRoleUserId,
      resource_type: "connector",
      resource_id: connectorReadId,
      permission: "connector:read",
    });
    await grantsSvc.grantResource(db, {
      tenant_id: tenantId,
      subject_type: "user",
      subject_id: noRoleUserId,
      resource_type: "connector",
      resource_id: connectorRWId,
      permission: "connector:read",
    });
    await grantsSvc.grantResource(db, {
      tenant_id: tenantId,
      subject_type: "user",
      subject_id: noRoleUserId,
      resource_type: "connector",
      resource_id: connectorRWId,
      permission: "connector:write",
    });
  }, 60_000);

  afterAll(async () => {
    if (testDb) await testDb.cleanup();
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

  test("a wildcard resource id is evaluated without querying the uuid grant column", async () => {
    const d = await can(db, {
      tenant_id: tenantId,
      principal: mkPrincipal(memberUserId, "member"),
      permission: "connector:read",
      resource: { type: "connector", id: "*" },
    });
    expect(d.allow).toBe(true);
    expect(d.source).toBe("role");
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

  test("a genuine deny WARN-logs (rbac.denied)", async () => {
    const warnSpy = spyOn(logger, "warn");
    const debugSpy = spyOn(logger, "debug");
    try {
      const d = await can(db, {
        tenant_id: tenantId,
        principal: mkPrincipal(memberUserId, "member"),
        permission: "audit:read",
      });
      expect(d.allow).toBe(false);
      const denyWarn = warnSpy.mock.calls.find(
        (c) => (c[0] as { module?: string; action?: string })?.action === "denied",
      );
      expect(denyWarn).toBeDefined();
      const checkedDebug = debugSpy.mock.calls.find(
        (c) => (c[0] as { module?: string; action?: string })?.action === "checked",
      );
      expect(checkedDebug).toBeUndefined();
    } finally {
      warnSpy.mockRestore();
      debugSpy.mockRestore();
    }
  });

  test("a quiet deny logs at DEBUG (rbac.checked), never WARN", async () => {
    const warnSpy = spyOn(logger, "warn");
    const debugSpy = spyOn(logger, "debug");
    try {
      const d = await can(db, {
        tenant_id: tenantId,
        principal: mkPrincipal(memberUserId, "member"),
        permission: "audit:read",
        quiet: true,
      });
      expect(d.allow).toBe(false);
      const denyWarn = warnSpy.mock.calls.find(
        (c) => (c[0] as { module?: string; action?: string })?.action === "denied",
      );
      expect(denyWarn).toBeUndefined();
      const checkedDebug = debugSpy.mock.calls.find(
        (c) =>
          (c[0] as { action?: string; allow?: boolean })?.action === "checked" &&
          (c[0] as { allow?: boolean })?.allow === false,
      );
      expect(checkedDebug).toBeDefined();
    } finally {
      warnSpy.mockRestore();
      debugSpy.mockRestore();
    }
  });

  test("group-subject resource grant resolves for a member", async () => {
    const d = await can(db, {
      tenant_id: tenantId,
      principal: mkPrincipal(groupGrantUserId, "member"),
      permission: "audit:read",
      resource: { type: "workflow", id: workflowA },
    });
    expect(d.allow).toBe(true);
    expect(d.source).toBe("resource_grant");
  });

  test("expired resource grant does not allow", async () => {
    const d = await can(db, {
      tenant_id: tenantId,
      principal: mkPrincipal(expiryUserId, "member"),
      permission: "audit:read",
      resource: { type: "workflow", id: workflowB },
    });
    expect(d.allow).toBe(false);
  });

  test("future (unexpired) resource grant allows", async () => {
    const d = await can(db, {
      tenant_id: tenantId,
      principal: mkPrincipal(expiryUserId, "member"),
      permission: "audit:read",
      resource: { type: "workflow", id: workflowFuture },
    });
    expect(d.allow).toBe(true);
    expect(d.source).toBe("resource_grant");
  });

  function adminWith(extra: Partial<ResolvedPrincipal>): ResolvedPrincipal {
    return { ...mkPrincipal(adminUserId, "admin"), ...extra };
  }

  test("wildcard scope ['*'] does not narrow the admin key", async () => {
    const d = await can(db, {
      tenant_id: tenantId,
      principal: adminWith({ scopes: ["*"] }),
      permission: "connector:write",
      resource: { type: "connector", id: connectorNoneId },
    });
    expect(d.allow).toBe(true);
    expect(d.source).toBe("builtin_admin");
  });

  test("a resource:action scope ceiling narrows even an admin", async () => {
    const d = await can(db, {
      tenant_id: tenantId,
      principal: adminWith({ scopes: ["workflow:read"] }),
      permission: "connector:write",
      resource: { type: "connector", id: connectorNoneId },
    });
    expect(d.allow).toBe(false);
    expect(d.source).toBe("credential_ceiling");
    expect(d.reason).toBe("credential_ceiling:scope_not_granted");
  });

  test("a scope within the ceiling is allowed", async () => {
    const d = await can(db, {
      tenant_id: tenantId,
      principal: adminWith({ scopes: ["connector:write"] }),
      permission: "connector:write",
      resource: { type: "connector", id: connectorNoneId },
    });
    expect(d.allow).toBe(true);
  });

  test("mcp:* marker-only scopes do not narrow", async () => {
    for (const markers of [["mcp:authoring"], ["mcp:read"], ["mcp:admin"]]) {
      const d = await can(db, {
        tenant_id: tenantId,
        principal: adminWith({ scopes: markers }),
        permission: "connector:write",
        resource: { type: "connector", id: connectorNoneId },
      });
      expect(d.allow).toBe(true);
    }
  });

  test("allowed_connectors ceiling denies a connector outside the list — even for admin", async () => {
    const d = await can(db, {
      tenant_id: tenantId,
      principal: adminWith({ allowed_connectors: [connectorReadId] }),
      permission: "connector:write",
      resource: { type: "connector", id: connectorNoneId },
    });
    expect(d.allow).toBe(false);
    expect(d.reason).toBe("credential_ceiling:connector_not_in_allowlist");
  });

  test("allowed_connectors ceiling allows a connector in the list", async () => {
    const d = await can(db, {
      tenant_id: tenantId,
      principal: adminWith({ allowed_connectors: [connectorReadId] }),
      permission: "connector:write",
      resource: { type: "connector", id: connectorReadId },
    });
    expect(d.allow).toBe(true);
  });

  test("allowed_workflows ceiling denies a workflow outside the list", async () => {
    const d = await can(db, {
      tenant_id: tenantId,
      principal: adminWith({ allowed_workflows: [workflowA] }),
      permission: "workflow:run",
      resource: { type: "workflow", id: workflowB },
    });
    expect(d.allow).toBe(false);
    expect(d.reason).toBe("credential_ceiling:workflow_not_in_allowlist");
  });

  test("absent credential fields are a no-op", async () => {
    const d = await can(db, {
      tenant_id: tenantId,
      principal: mkPrincipal(memberUserId, "member"),
      permission: "workflow:read",
    });
    expect(d.allow).toBe(true);
    expect(d.source).toBe("role");
  });

  test("a system_account credential is also narrowed by a scope ceiling", async () => {
    const principal: ResolvedPrincipal = {
      provider: "api_key",
      kind: "system_account",
      id: adminUserId,
      tenant_id: tenantId,
      roles: ["admin"],
      scopes: ["workflow:read"],
    };
    const d = await can(db, {
      tenant_id: tenantId,
      principal,
      permission: "connector:write",
      resource: { type: "connector", id: connectorNoneId },
    });
    expect(d.allow).toBe(false);
    expect(d.source).toBe("credential_ceiling");
  });

  test("a mixed scope set (mcp marker + one permission) narrows to that permission", async () => {
    const principal = adminWith({ scopes: ["mcp:authoring", "workflow:read"] });
    const allowed = await can(db, {
      tenant_id: tenantId,
      principal,
      permission: "workflow:read",
      resource: { type: "workflow", id: workflowA },
    });
    expect(allowed.allow).toBe(true);
    const denied = await can(db, {
      tenant_id: tenantId,
      principal,
      permission: "connector:write",
      resource: { type: "connector", id: connectorNoneId },
    });
    expect(denied.allow).toBe(false);
    expect(denied.reason).toBe("credential_ceiling:scope_not_granted");
  });

  test('allowed_connectors "all" imposes no ceiling', async () => {
    const d = await can(db, {
      tenant_id: tenantId,
      principal: adminWith({ allowed_connectors: "all" }),
      permission: "connector:write",
      resource: { type: "connector", id: connectorNoneId },
    });
    expect(d.allow).toBe(true);
  });

  test('allowed_workflows "all" imposes no ceiling', async () => {
    const d = await can(db, {
      tenant_id: tenantId,
      principal: adminWith({ allowed_workflows: "all" }),
      permission: "workflow:run",
      resource: { type: "workflow", id: workflowB },
    });
    expect(d.allow).toBe(true);
  });

  test("allowed_connectors ceiling does not affect non-connector resources", async () => {
    const d = await can(db, {
      tenant_id: tenantId,
      principal: adminWith({ allowed_connectors: [connectorReadId] }),
      permission: "workflow:run",
      resource: { type: "workflow", id: workflowB },
    });
    expect(d.allow).toBe(true);
  });

  test("a group-subject grant does not leak to a non-member", async () => {
    const d = await can(db, {
      tenant_id: tenantId,
      principal: mkPrincipal(memberUserId, "member"),
      permission: "audit:read",
      resource: { type: "workflow", id: workflowA },
    });
    expect(d.allow).toBe(false);
  });

  test("an expired group-subject grant does not allow", async () => {
    const d = await can(db, {
      tenant_id: tenantId,
      principal: mkPrincipal(groupGrantUserId, "member"),
      permission: "audit:read",
      resource: { type: "workflow", id: workflowB },
    });
    expect(d.allow).toBe(false);
  });

  test("deny carries actionable detail", async () => {
    const d = await can(db, {
      tenant_id: tenantId,
      principal: mkPrincipal(memberUserId, "member"),
      permission: "audit:read",
    });
    expect(d.allow).toBe(false);
    expect(d.detail?.required).toBe("audit:read");
    expect(d.detail?.cause).toBe("no_matching_grant");
  });

  test("connectorAccessLevel reflects grants", async () => {
    const principal: ResolvedPrincipal = {
      provider: "api_key",
      kind: "user",
      id: noRoleUserId,
      tenant_id: tenantId,
      roles: [],
    };
    expect(await connectorAccessLevel(db, principal, connectorRWId, tenantId)).toBe("read-write");
    expect(await connectorAccessLevel(db, principal, connectorReadId, tenantId)).toBe("read-only");
    expect(await connectorAccessLevel(db, principal, connectorNoneId, tenantId)).toBe("none");
  });

  test("connectorAccessLevel is read-write for admin", async () => {
    const level = await connectorAccessLevel(
      db,
      mkPrincipal(adminUserId, "admin"),
      connectorNoneId,
      tenantId,
    );
    expect(level).toBe("read-write");
  });

  void permissionsTable;
  void rolePermissions;
  void systemAccounts;
  void workflowA;
});
