import { afterAll, beforeAll } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import {
  groupMembers,
  groupRoleAssignments,
  groups,
  roles as rolesTable,
  systemAccounts,
  tenants,
  users,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { emptyRoleId } from "../../test-helpers/roles.ts";
import * as grantsSvc from "../grants.ts";
import { BUILTIN_ROLE_NAMES } from "../seed.ts";

let testDb: TestDb;

export let db: Db;

export let tenantA: string;

export let tenantB: string;

export const principals: Record<string, ResolvedPrincipal> = {};

export let memberB: ResolvedPrincipal;

export const workflowAlpha = "11111111-1111-1111-1111-111111111111";

export const workflowBeta = "22222222-2222-2222-2222-222222222222";

export let grantedMember: ResolvedPrincipal;

export let groupMember: ResolvedPrincipal;

export function useRbacMatrixDb(): void {
  beforeAll(async () => {
    testDb = await createTestDb("rbac-matrix");
    db = testDb.db;

    const [a] = await db
      .insert(tenants)
      .values({ slug: "rbac-mx-a", display_name: "rbac-mx-a", is_operator: true })
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
}
