import { afterAll, beforeAll } from "bun:test";
import { eq } from "drizzle-orm";
import { auditLog } from "../../db/schema/audit.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { seedTenant } from "../../test-helpers/seed.ts";

export let testDb: TestDb;

export let tenantId = "";

export async function fetchRow(id: string) {
  const rows = await testDb.db.select().from(auditLog).where(eq(auditLog.id, id));
  return rows[0];
}

export function useRecorderDb(): void {
  beforeAll(async () => {
    testDb = await createTestDb("audit-recorders");
    tenantId = (
      await seedTenant(testDb.db, { slug: "recorder-tenant", display_name: "Recorder Tenant" })
    ).id;
  });
  afterAll(async () => {
    await testDb.cleanup();
  });
}
