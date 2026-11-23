import { afterAll, beforeAll } from "bun:test";
import { eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import { auditLog, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";

export const PRINCIPAL: ResolvedPrincipal = {
  provider: "test",
  kind: "user",
  id: "00000000-0000-4000-8000-000000000001",
  tenant_id: "00000000-0000-4000-8000-000000000002",
  scopes: [],
  roles: [],
};

interface UpdateStub {
  set(): UpdateStub;
  where(): UpdateStub;
  returning(): Promise<unknown[]>;
}

const UPDATE_STUB: UpdateStub = {
  set: () => UPDATE_STUB,
  where: () => UPDATE_STUB,
  returning: () => Promise.resolve([]),
};

const dbStub: Record<string, unknown> = {
  transaction: async (fn: (db: unknown) => unknown) => fn(dbStub),
  execute: async () => ({ rows: [{ previous_role: "none", previous_tenant: null }] }),
  insert: () => ({ values: () => ({ onConflictDoNothing: async () => undefined }) }),
  update: () => UPDATE_STUB,
};

export const DB_STUB = dbStub as unknown as Db;

export const nextId = createDeterministicUuidFactory(2);

export let testDb: TestDb;

let dbTenantId: string;

export function dbPrincipal(overrides: Partial<ResolvedPrincipal> = {}): ResolvedPrincipal {
  return { ...PRINCIPAL, tenant_id: dbTenantId, ...overrides };
}

export async function approvalAuditRows(
  approval_id: string,
): Promise<Array<{ action: string; resource_id: string | null; metadata: unknown }>> {
  return testDb.db
    .select({
      action: auditLog.action,
      resource_id: auditLog.resource_id,
      metadata: auditLog.metadata,
    })
    .from(auditLog)
    .where(eq(auditLog.resource_id, approval_id));
}

export function useDispatcherDb(): void {
  beforeAll(async () => {
    testDb = await createTestDb("dispatcher-confirm");
    DB_STUB.select = testDb.db.select.bind(testDb.db);
    await testDb.db.insert(tenants).values({
      id: PRINCIPAL.tenant_id,
      slug: "dispatcher-policy-fixture",
      display_name: "Dispatcher Policy",
    });
    const [tenant] = await testDb.db
      .insert(tenants)
      .values({ slug: "t-dispatcher-confirm", display_name: "Dispatcher Confirm" })
      .returning();
    dbTenantId = tenant!.id;
  }, 120_000);
  afterAll(async () => {
    await testDb.cleanup();
  }, 120_000);
}
