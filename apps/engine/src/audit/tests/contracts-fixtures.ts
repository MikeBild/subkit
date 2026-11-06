import { afterAll, beforeAll } from "bun:test";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { seedTenant } from "../../test-helpers/seed.ts";

export const uuid = createDeterministicUuidFactory(0xa11d11);

export let testDb: TestDb;

export let tenantA = "";

export let tenantB = "";

export function useAuditContractsDb(): void {
  beforeAll(async () => {
    testDb = await createTestDb("audit-contracts");
    const a = await seedTenant(testDb.db, {
      slug: "audit-cn-a",
      display_name: "Audit-Contracts A",
    });
    const b = await seedTenant(testDb.db, {
      slug: "audit-cn-b",
      display_name: "Audit-Contracts B",
    });
    if (!a || !b) throw new Error("seed tenants");
    tenantA = a.id;
    tenantB = b.id;
  });
  afterAll(async () => {
    await testDb.cleanup();
  });
}
