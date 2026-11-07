import { afterAll, beforeAll } from "bun:test";
import { eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import { users } from "../../db/schema/index.ts";
import { createTestDb, TEST_DB_HOOK_TIMEOUT, type TestDb } from "../../db/tests/setup.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { can, type Decision } from "../evaluator.ts";
import { roleNameById } from "../role-names.ts";
import { builtinRoleId } from "../roles.ts";

export const MISSING_ID = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";

export interface RbacWorld {
  db: Db;
  tenantA: string;
  tenantB: string;
  adminRoleId: string;
  memberRoleId: string;
}

export const world: RbacWorld = {
  db: undefined as unknown as Db,
  tenantA: "",
  tenantB: "",
  adminRoleId: "",
  memberRoleId: "",
};

let testDb: TestDb | undefined;
let userSequence = 0;

export function useRbacWorld(label: string): void {
  beforeAll(async () => {
    testDb = await createTestDb(label);
    world.db = testDb.db;
    world.tenantA = (await seedTenant(world.db)).id;
    world.tenantB = (await seedTenant(world.db)).id;
    world.adminRoleId = await builtinRoleId(world.db, "admin");
    world.memberRoleId = await builtinRoleId(world.db, "member");
  }, TEST_DB_HOOK_TIMEOUT);
  afterAll(async () => {
    if (testDb) await testDb.cleanup();
  });
}

export async function seedUser(tenant_id: string, role_id: string): Promise<string> {
  userSequence += 1;
  const [row] = await world.db
    .insert(users)
    .values({ tenant_id, email: `user-${userSequence}@rbac.test`, role_id })
    .returning({ id: users.id });
  if (!row) throw new Error("seed user");
  return row.id;
}

export async function sessionPrincipal(
  user_id: string,
  tenant_id: string,
): Promise<ResolvedPrincipal> {
  const [user] = await world.db
    .select({ role_id: users.role_id })
    .from(users)
    .where(eq(users.id, user_id))
    .limit(1);
  if (!user) throw new Error("principal user");
  const roleName = await roleNameById(world.db, tenant_id, user.role_id);
  return {
    provider: "browser_session",
    kind: "user",
    id: user_id,
    tenant_id,
    roles: roleName ? [roleName] : [],
  };
}

export async function decide(
  user_id: string,
  tenant_id: string,
  permission: string,
): Promise<Decision> {
  const principal = await sessionPrincipal(user_id, tenant_id);
  return can(world.db, { tenant_id, principal, permission });
}
