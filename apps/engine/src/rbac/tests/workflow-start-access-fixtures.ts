import { afterAll, beforeAll } from "bun:test";
import { eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import {
  groupMembers,
  groupRoleAssignments,
  groups,
  systemAccounts,
  tenants,
  users,
} from "../../db/schema/index.ts";
import { createTestDb, TEST_DB_HOOK_TIMEOUT, type TestDb } from "../../db/tests/setup.ts";
import {
  createDeterministicClock,
  FROZEN_NOW,
  installClock,
  restoreClock,
} from "../../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import type { NowProvider } from "../../utils/clock.ts";
import { builtinRoleId, createRole, grantPermissionToRole } from "../roles.ts";

export const AT = new Date(FROZEN_NOW);

export interface AccessDb {
  db: Db;
  testDb: TestDb;
  nextId: () => string;
}

export function useAccessDb(label: string, seed: number): AccessDb {
  const handle = { nextId: createDeterministicUuidFactory(seed) } as AccessDb;
  let previousClock: NowProvider | null = null;
  beforeAll(async () => {
    previousClock = installClock(createDeterministicClock(FROZEN_NOW));
    handle.testDb = await createTestDb(label);
    handle.db = handle.testDb.db;
  }, TEST_DB_HOOK_TIMEOUT);
  afterAll(async () => {
    restoreClock(previousClock);
    if (handle.testDb) await handle.testDb.cleanup();
  });
  return handle;
}

export async function addTenant(h: AccessDb, slug: string, isOperator = false): Promise<string> {
  const id = h.nextId();
  await h.db
    .insert(tenants)
    .values({ id, slug, display_name: slug, is_operator: isOperator, created_at: AT });
  return id;
}

export async function setOperator(h: AccessDb, tenantId: string, value: boolean): Promise<void> {
  await h.db.update(tenants).set({ is_operator: value }).where(eq(tenants.id, tenantId));
}

export function builtinRole(h: AccessDb, name: string): Promise<string> {
  return builtinRoleId(h.db, name);
}

export async function customRole(
  h: AccessDb,
  tenantId: string,
  name: string,
  permissionNames: readonly string[],
): Promise<string> {
  const role = await createRole(h.db, tenantId, name);
  for (const permission of permissionNames) {
    await grantPermissionToRole(h.db, tenantId, role.id, permission);
  }
  return role.id;
}

export async function addUser(
  h: AccessDb,
  tenantId: string,
  email: string,
  roleId: string,
): Promise<string> {
  const id = h.nextId();
  await h.db.insert(users).values({ id, tenant_id: tenantId, email, role_id: roleId });
  return id;
}

export async function addSystemAccount(
  h: AccessDb,
  tenantId: string,
  name: string,
  roleId: string | null,
): Promise<string> {
  const id = h.nextId();
  await h.db.insert(systemAccounts).values({ id, tenant_id: tenantId, name, role_id: roleId });
  return id;
}

export async function addGroup(
  h: AccessDb,
  tenantId: string,
  name: string,
  roleIds: readonly string[],
  memberIds: readonly string[],
): Promise<string> {
  const id = h.nextId();
  await h.db.insert(groups).values({ id, tenant_id: tenantId, name });
  for (const role_id of roleIds)
    await h.db.insert(groupRoleAssignments).values({ group_id: id, role_id });
  for (const user_id of memberIds)
    await h.db.insert(groupMembers).values({ group_id: id, user_id });
  return id;
}

export function userPrincipal(
  tenantId: string,
  id: string,
  roles: string[],
  extra: Partial<ResolvedPrincipal> = {},
): ResolvedPrincipal {
  return { provider: "api_key", kind: "user", id, tenant_id: tenantId, roles, ...extra };
}

export function systemPrincipal(
  tenantId: string,
  id: string,
  roles: string[],
  extra: Partial<ResolvedPrincipal> = {},
): ResolvedPrincipal {
  return { provider: "api_key", kind: "system_account", id, tenant_id: tenantId, roles, ...extra };
}
