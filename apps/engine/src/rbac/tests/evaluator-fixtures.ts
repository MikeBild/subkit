import { afterAll, beforeAll } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import {
  groupMembers,
  groupRoleAssignments,
  groups,
  roles as rolesTable,
  tenants,
  users,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { emptyRoleId } from "../../test-helpers/roles.ts";
import { now } from "../../utils/clock.ts";
import * as grantsSvc from "../grants.ts";

let testDb: TestDb;

export let db: Db;

export let tenantId: string;

export let adminUserId: string;

export let memberUserId: string;

export let resourceGrantUserId: string;

export let groupUserId: string;

export let noRoleUserId: string;

export let groupGrantUserId: string;

export let expiryUserId: string;

export const workflowA = "11111111-1111-1111-1111-111111111111";

export const workflowB = "22222222-2222-2222-2222-222222222222";

export const workflowFuture = "66666666-6666-6666-6666-666666666666";

export const connectorReadId = "33333333-3333-3333-3333-333333333333";

export const connectorRWId = "44444444-4444-4444-4444-444444444444";

export function mkPrincipal(id: string, roleName: string): ResolvedPrincipal {
  return {
    provider: "api_key",
    kind: "user",
    id,
    tenant_id: tenantId,
    roles: [roleName],
  };
}

export function useRbacEvaluatorDb(): void {
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
}
