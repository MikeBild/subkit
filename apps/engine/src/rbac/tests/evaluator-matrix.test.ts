import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import {
  groupMembers,
  groupRoleAssignments,
  groups,
  resourceGrants,
  roles as rolesTable,
  systemAccounts,
  tenants,
  users,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { emptyRoleId } from "../../test-helpers/roles.ts";
import { ALL_PERMISSION_NAMES, getPermissionByName, loadPermissionCatalog } from "../catalog.ts";
import { assertCan, can } from "../evaluator.ts";
import * as grantsSvc from "../grants.ts";
import { BUILTIN_ROLE_NAMES } from "../seed.ts";

const ENDUSER_PERMISSIONS = new Set<string>([
  "workflow:read",
  "workflow:run",
  "execution:read",
  "conversation:read",
  "conversation:write",
  "conversation:cancel",
  "conversation:list",
  "knowledge:read",
  "skill:read",
  "file:read",
]);
const METRICS_SCRAPER_PERMISSIONS = new Set<string>(["metrics:read"]);
const PORTAL_TOKEN_USER_PERMISSIONS = new Set<string>([
  "workflow:read",
  "workflow:run",
  "conversation:read",
  "conversation:write",
  "conversation:cancel",
]);

function memberAllows(name: string): boolean {
  if (name.startsWith("rbac:")) return false;
  if (name === "audit:read") return false;
  if (name === "identity:write") return false;
  if (name === "api_key:write") return false;
  if (name === "api_key:rotate") return false;
  if (name === "api_key:revoke") return false;
  if (name === "connector:promote") return false;
  if (name.startsWith("credential:") && name !== "credential:read") return false;
  if (name === "discovery:approve") return false;
  if (name === "stats:read") return false;
  if (name === "stats:read:all") return false;
  if (name.startsWith("self_healing:")) return false;
  if (name === "mcp:admin") return false;
  if (name.startsWith("mcp_oauth_client:")) return false;
  if (name === "system:restart") return false;
  if (name.startsWith("chat_workspace:") && name !== "chat_workspace:read") return false;
  if (name.startsWith("chat_identity:") && name !== "chat_identity:read") return false;
  return true;
}

function expectedAllow(roleName: string, permission: string): boolean {
  switch (roleName) {
    case BUILTIN_ROLE_NAMES.ADMIN:
      return true;
    case BUILTIN_ROLE_NAMES.MEMBER:
      return memberAllows(permission);
    case BUILTIN_ROLE_NAMES.ENDUSER:
      return ENDUSER_PERMISSIONS.has(permission);
    case BUILTIN_ROLE_NAMES.METRICS_SCRAPER:
      return METRICS_SCRAPER_PERMISSIONS.has(permission);
    case BUILTIN_ROLE_NAMES.PORTAL_TOKEN_USER:
      return PORTAL_TOKEN_USER_PERMISSIONS.has(permission);
    default:
      throw new Error(`unknown role ${roleName}`);
  }
}

describe("rbac matrix", () => {
  let testDb: TestDb;
  let db: Db;
  let tenantA: string;
  let tenantB: string;

  const principals: Record<string, ResolvedPrincipal> = {};
  let memberB: ResolvedPrincipal;

  const workflowAlpha = "11111111-1111-1111-1111-111111111111";
  const workflowBeta = "22222222-2222-2222-2222-222222222222";
  let grantedMember: ResolvedPrincipal;
  let groupMember: ResolvedPrincipal;

  beforeAll(async () => {
    testDb = await createTestDb("rbac-matrix");
    db = testDb.db;

    const [a] = await db
      .insert(tenants)
      .values({ slug: "rbac-mx-a", display_name: "rbac-mx-a" })
      .returning();
    const [b] = await db
      .insert(tenants)
      .values({ slug: "rbac-mx-b", display_name: "rbac-mx-b" })
      .returning();
    if (!a || !b) throw new Error("seed tenants");
    tenantA = a.id;
    tenantB = b.id;

    const findRoleId = async (name: string) => {
      const rows = await db
        .select({ id: rolesTable.id })
        .from(rolesTable)
        .where(and(isNull(rolesTable.tenant_id), eq(rolesTable.name, name)))
        .limit(1);
      const id = rows[0]?.id;
      if (!id) throw new Error(`builtin role ${name} missing`);
      return id;
    };

    const adminRoleId = await findRoleId(BUILTIN_ROLE_NAMES.ADMIN);
    const memberRoleId = await findRoleId(BUILTIN_ROLE_NAMES.MEMBER);
    const enduserRoleId = await findRoleId(BUILTIN_ROLE_NAMES.ENDUSER);
    const metricsRoleId = await findRoleId(BUILTIN_ROLE_NAMES.METRICS_SCRAPER);
    const portalUserRoleId = await findRoleId(BUILTIN_ROLE_NAMES.PORTAL_TOKEN_USER);

    const seedUser = async (tenantId: string, email: string, roleId: string): Promise<string> => {
      const [row] = await db
        .insert(users)
        .values({ tenant_id: tenantId, email, role_id: roleId })
        .returning({ id: users.id });
      if (!row) throw new Error("seed user");
      return row.id;
    };
    const seedSystemAccount = async (
      tenantId: string,
      name: string,
      roleId: string,
    ): Promise<string> => {
      const [row] = await db
        .insert(systemAccounts)
        .values({ tenant_id: tenantId, name, role_id: roleId })
        .returning({ id: systemAccounts.id });
      if (!row) throw new Error("seed system account");
      return row.id;
    };

    const adminId = await seedUser(tenantA, "admin@a", adminRoleId);
    const memberId = await seedUser(tenantA, "member@a", memberRoleId);
    const enduserId = await seedUser(tenantA, "enduser@a", enduserRoleId);
    const metricsAcctId = await seedSystemAccount(tenantA, "metrics-scraper-a", metricsRoleId);
    const portalUserId = await seedUser(tenantA, "portaluser@a", portalUserRoleId);

    principals[BUILTIN_ROLE_NAMES.ADMIN] = {
      provider: "api_key",
      kind: "user",
      id: adminId,
      tenant_id: tenantA,
      roles: [BUILTIN_ROLE_NAMES.ADMIN],
    };
    principals[BUILTIN_ROLE_NAMES.MEMBER] = {
      provider: "api_key",
      kind: "user",
      id: memberId,
      tenant_id: tenantA,
      roles: [BUILTIN_ROLE_NAMES.MEMBER],
    };
    principals[BUILTIN_ROLE_NAMES.ENDUSER] = {
      provider: "api_key",
      kind: "user",
      id: enduserId,
      tenant_id: tenantA,
      roles: [BUILTIN_ROLE_NAMES.ENDUSER],
    };
    principals[BUILTIN_ROLE_NAMES.METRICS_SCRAPER] = {
      provider: "api_key",
      kind: "system_account",
      id: metricsAcctId,
      tenant_id: tenantA,
      roles: [BUILTIN_ROLE_NAMES.METRICS_SCRAPER],
    };
    principals[BUILTIN_ROLE_NAMES.PORTAL_TOKEN_USER] = {
      provider: "api_key",
      kind: "user",
      id: portalUserId,
      tenant_id: tenantA,
      roles: [BUILTIN_ROLE_NAMES.PORTAL_TOKEN_USER],
    };

    const memberBId = await seedUser(tenantB, "member@b", memberRoleId);
    memberB = {
      provider: "api_key",
      kind: "user",
      id: memberBId,
      tenant_id: tenantB,
      roles: [BUILTIN_ROLE_NAMES.MEMBER],
    };

    const grantedId = await seedUser(tenantA, "granted@a", memberRoleId);
    grantedMember = {
      provider: "api_key",
      kind: "user",
      id: grantedId,
      tenant_id: tenantA,
      roles: [BUILTIN_ROLE_NAMES.MEMBER],
    };
    await grantsSvc.grantResource(db, {
      tenant_id: tenantA,
      subject_type: "user",
      subject_id: grantedId,
      resource_type: "workflow",
      resource_id: workflowAlpha,
      permission: "audit:read",
    });

    const groupUserId = await seedUser(tenantA, "groupie@a", await emptyRoleId(db, tenantA));
    const [group] = await db
      .insert(groups)
      .values({ tenant_id: tenantA, name: "ops" })
      .returning({ id: groups.id });
    if (!group) throw new Error("seed group");
    await db.insert(groupRoleAssignments).values({ group_id: group.id, role_id: adminRoleId });
    await db.insert(groupMembers).values({ group_id: group.id, user_id: groupUserId });
    groupMember = {
      provider: "api_key",
      kind: "user",
      id: groupUserId,
      tenant_id: tenantA,
      roles: [],
    };
  });

  afterAll(async () => {
    await testDb.cleanup();
  });

  describe("role × permission catalogue", () => {
    test("the catalogue is what we think it is", () => {
      expect(ALL_PERMISSION_NAMES.length).toBe(loadPermissionCatalog().length);
      expect(ALL_PERMISSION_NAMES.length).toBeGreaterThanOrEqual(60);
    });

    for (const roleName of Object.values(BUILTIN_ROLE_NAMES)) {
      describe(`role=${roleName}`, () => {
        test(`every permission resolves to its expected allow/deny (${roleName})`, async () => {
          const principal = principals[roleName];
          if (!principal) throw new Error(`no principal for ${roleName}`);
          for (const permission of ALL_PERMISSION_NAMES) {
            const decision = await can(db, {
              tenant_id: tenantA,
              principal,
              permission,
            });
            const expected = expectedAllow(roleName, permission);
            if (decision.allow !== expected) {
              throw new Error(
                `RBAC matrix mismatch: role=${roleName} permission=${permission} expected_allow=${expected} got_allow=${decision.allow} reason=${decision.reason ?? "n/a"}`,
              );
            }
            expect(decision.allow).toBe(expected);
            if (decision.allow) {
              expect(decision.source).toBeDefined();
            } else {
              expect(decision.reason).toBeDefined();
              expect(decision.reason).toContain("permission_denied");
            }
          }
        });
      });
    }
  });

  describe("decision sources", () => {
    test("admin always uses the builtin_admin short-circuit", async () => {
      const decision = await can(db, {
        tenant_id: tenantA,
        principal: principals[BUILTIN_ROLE_NAMES.ADMIN]!,
        permission: "rbac:write",
      });
      expect(decision.allow).toBe(true);
      expect(decision.source).toBe("builtin_admin");
    });

    test("non-admin allows are attributed to role", async () => {
      const decision = await can(db, {
        tenant_id: tenantA,
        principal: principals[BUILTIN_ROLE_NAMES.MEMBER]!,
        permission: "workflow:read",
      });
      expect(decision.allow).toBe(true);
      expect(decision.source).toBe("role");
    });

    test("system account allows are attributed to role", async () => {
      const decision = await can(db, {
        tenant_id: tenantA,
        principal: principals[BUILTIN_ROLE_NAMES.METRICS_SCRAPER]!,
        permission: "metrics:read",
      });
      expect(decision.allow).toBe(true);
      expect(decision.source).toBe("role");
    });

    test("group membership grants admin via the group path", async () => {
      const decision = await can(db, {
        tenant_id: tenantA,
        principal: groupMember,
        permission: "rbac:write",
      });
      expect(decision.allow).toBe(true);
      expect(decision.source).toBe("group");
    });
  });

  describe("resource-scoped grants", () => {
    test("grant allows only on the granted resource", async () => {
      const onTarget = await can(db, {
        tenant_id: tenantA,
        principal: grantedMember,
        permission: "audit:read",
        resource: { type: "workflow", id: workflowAlpha },
      });
      expect(onTarget.allow).toBe(true);
      expect(onTarget.source).toBe("resource_grant");

      const offTarget = await can(db, {
        tenant_id: tenantA,
        principal: grantedMember,
        permission: "audit:read",
        resource: { type: "workflow", id: workflowBeta },
      });
      expect(offTarget.allow).toBe(false);
    });

    test("grant does not bypass tenant boundary", async () => {
      const decision = await can(db, {
        tenant_id: tenantB,
        principal: grantedMember,
        permission: "audit:read",
        resource: { type: "workflow", id: workflowAlpha },
      });
      expect(decision.allow).toBe(false);
    });

    test("grant on system_account subject works the same way", async () => {
      const metricsAcct = principals[BUILTIN_ROLE_NAMES.METRICS_SCRAPER]!;
      await grantsSvc.grantResource(db, {
        tenant_id: tenantA,
        subject_type: "system_account",
        subject_id: metricsAcct.id,
        resource_type: "workflow",
        resource_id: workflowBeta,
        permission: "workflow:run",
      });
      const onTarget = await can(db, {
        tenant_id: tenantA,
        principal: metricsAcct,
        permission: "workflow:run",
        resource: { type: "workflow", id: workflowBeta },
      });
      expect(onTarget.allow).toBe(true);
      expect(onTarget.source).toBe("resource_grant");
    });
  });

  describe("portal_token allowlist", () => {
    function portalToken(
      principalId: string,
      allowed: string[] | "all" | undefined,
    ): ResolvedPrincipal {
      const base: ResolvedPrincipal = {
        provider: "portal_token",
        kind: "user",
        id: principalId,
        tenant_id: tenantA,
        roles: ["enduser"],
      };
      if (allowed !== undefined) base.allowed_workflows = allowed;
      return base;
    }

    test("workflow:run allowed when resource is on the allowlist", async () => {
      const decision = await can(db, {
        tenant_id: tenantA,
        principal: portalToken(grantedMember.id, [workflowAlpha]),
        permission: "workflow:run",
        resource: { type: "workflow", id: workflowAlpha },
      });
      expect(decision.allow).toBe(true);
      expect(decision.source).toBe("portal_token_allowlist");
    });

    test("workflow:run denied when resource is off the allowlist", async () => {
      const decision = await can(db, {
        tenant_id: tenantA,
        principal: portalToken(grantedMember.id, [workflowAlpha]),
        permission: "workflow:run",
        resource: { type: "workflow", id: workflowBeta },
      });
      expect(decision.allow).toBe(false);
      expect(decision.reason).toBe("workflow_not_in_allowlist");
    });

    test("allowed='all' grants any workflow:run", async () => {
      const decision = await can(db, {
        tenant_id: tenantA,
        principal: portalToken(grantedMember.id, "all"),
        permission: "workflow:run",
        resource: { type: "workflow", id: workflowBeta },
      });
      expect(decision.allow).toBe(true);
      expect(decision.source).toBe("portal_token_allowlist");
    });

    test("missing allowed_workflows denies", async () => {
      const decision = await can(db, {
        tenant_id: tenantA,
        principal: portalToken(grantedMember.id, undefined),
        permission: "workflow:run",
        resource: { type: "workflow", id: workflowAlpha },
      });
      expect(decision.allow).toBe(false);
    });

    test("empty allowlist denies workflow:run", async () => {
      const decision = await can(db, {
        tenant_id: tenantA,
        principal: portalToken(grantedMember.id, []),
        permission: "workflow:run",
        resource: { type: "workflow", id: workflowAlpha },
      });
      expect(decision.allow).toBe(false);
    });

    test("workflow:run requires a workflow resource", async () => {
      const decision = await can(db, {
        tenant_id: tenantA,
        principal: portalToken(grantedMember.id, [workflowAlpha]),
        permission: "workflow:run",
      });
      expect(decision.allow).toBe(false);
    });

    test("conversation:read allows without a resource when allowlist is non-empty", async () => {
      const decision = await can(db, {
        tenant_id: tenantA,
        principal: portalToken(grantedMember.id, [workflowAlpha]),
        permission: "conversation:read",
      });
      expect(decision.allow).toBe(true);
      expect(decision.source).toBe("portal_token_allowlist");
    });

    test("conversation:read denied with empty allowlist", async () => {
      const decision = await can(db, {
        tenant_id: tenantA,
        principal: portalToken(grantedMember.id, []),
        permission: "conversation:read",
      });
      expect(decision.allow).toBe(false);
    });

    test("conversation:approve never goes through the allowlist", async () => {
      const decision = await can(db, {
        tenant_id: tenantA,
        principal: portalToken(grantedMember.id, "all"),
        permission: "conversation:approve",
      });
      expect(decision.allow).toBe(false);
    });

    test("portal-token does NOT inherit the underlying user's role", async () => {
      const decision = await can(db, {
        tenant_id: tenantA,
        principal: portalToken(grantedMember.id, "all"),
        permission: "workflow:write",
      });
      expect(decision.allow).toBe(false);
    });

    test("portal-token does NOT inherit a resource grant on the underlying user (security)", async () => {
      const decision = await can(db, {
        tenant_id: tenantA,
        principal: portalToken(grantedMember.id, "all"),
        permission: "audit:read",
        resource: { type: "workflow", id: workflowAlpha },
      });
      expect(decision.allow).toBe(false);
      expect(decision.source).toBeUndefined();
    });
  });

  describe("tenant boundary", () => {
    test("a tenantB principal cannot satisfy a tenantA-scoped check", async () => {
      const decision = await can(db, {
        tenant_id: tenantA,
        principal: memberB,
        permission: "workflow:read",
      });
      expect(decision.allow).toBe(true);
      expect(decision.source).toBe("role");
    });

    test("a tenantA resource grant does not satisfy a tenantB-scoped check", async () => {
      const decision = await can(db, {
        tenant_id: tenantB,
        principal: grantedMember,
        permission: "audit:read",
        resource: { type: "workflow", id: workflowAlpha },
      });
      expect(decision.allow).toBe(false);
    });
  });

  describe("unknown permission", () => {
    test("denies and tags the reason", async () => {
      const decision = await can(db, {
        tenant_id: tenantA,
        principal: principals[BUILTIN_ROLE_NAMES.MEMBER]!,
        permission: "made_up:permission",
      });
      expect(decision.allow).toBe(false);
      expect(decision.reason).toBe("permission_unknown:made_up:permission");
    });

    test("admin still short-circuits ahead of permission lookup", async () => {
      const decision = await can(db, {
        tenant_id: tenantA,
        principal: principals[BUILTIN_ROLE_NAMES.ADMIN]!,
        permission: "made_up:permission",
      });
      expect(decision.allow).toBe(true);
      expect(decision.source).toBe("builtin_admin");
    });
  });

  describe("catalog lookup", () => {
    test("getPermissionByName returns the catalogue row", () => {
      const row = getPermissionByName("workflow:read");
      expect(row?.resource_type).toBe("workflow");
    });

    test("getPermissionByName returns undefined for unknown names", () => {
      expect(getPermissionByName("does:not:exist")).toBeUndefined();
    });
  });

  describe("assertCan helper", () => {
    test("returns the decision when allowed", async () => {
      const decision = await assertCan(db, {
        tenant_id: tenantA,
        principal: principals[BUILTIN_ROLE_NAMES.MEMBER]!,
        permission: "workflow:read",
      });
      expect(decision.allow).toBe(true);
    });

    test("throws with the deny reason on disallowed checks", async () => {
      await expect(
        assertCan(db, {
          tenant_id: tenantA,
          principal: principals[BUILTIN_ROLE_NAMES.MEMBER]!,
          permission: "rbac:write",
        }),
      ).rejects.toThrow("permission_denied:rbac:write");
    });
  });

  describe("principal.roles fallback", () => {
    test("a user principal without a user row falls back to principal.roles[name]", async () => {
      const decision = await can(db, {
        tenant_id: tenantA,
        principal: {
          provider: "api_key",
          kind: "user",
          id: "00000000-0000-4000-8000-00000000f00d",
          tenant_id: tenantA,
          roles: [BUILTIN_ROLE_NAMES.MEMBER],
        },
        permission: "workflow:read",
      });
      expect(decision.allow).toBe(true);
      expect(decision.source).toBe("role");
    });

    test("system_account with role_id=NULL falls back to principal.roles[name]", async () => {
      const [row] = await db
        .insert(systemAccounts)
        .values({ tenant_id: tenantA, name: "unassigned-sa", role_id: null })
        .returning({ id: systemAccounts.id });
      if (!row) throw new Error("seed sa");
      const decision = await can(db, {
        tenant_id: tenantA,
        principal: {
          provider: "api_key",
          kind: "system_account",
          id: row.id,
          tenant_id: tenantA,
          roles: [BUILTIN_ROLE_NAMES.METRICS_SCRAPER],
        },
        permission: "metrics:read",
      });
      expect(decision.allow).toBe(true);
      expect(decision.source).toBe("role");
    });

    test("a user principal without a user row and without roles is denied", async () => {
      const decision = await can(db, {
        tenant_id: tenantA,
        principal: {
          provider: "api_key",
          kind: "user",
          id: "00000000-0000-4000-8000-00000000f00e",
          tenant_id: tenantA,
          roles: [],
        },
        permission: "workflow:read",
      });
      expect(decision.allow).toBe(false);
    });
  });

  void resourceGrants;
});
