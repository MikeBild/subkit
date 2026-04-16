// Regression guard for the audit writer pool leak.
//
// Background: earlier iterations of the engine routed every audit
// write through the module-scoped db pool, ignoring the `executor`
// argument when it was a drizzle db handle (as opposed to a tx). That
// meant a caller that explicitly passed a per-test database still saw
// its audit rows land in the shared pool, breaking test isolation and,
// worse, cross-tenant bleed if the shared pool pointed at a different
// tenant's data.
//
// This test exercises the positive path: two disposable test databases
// receive audit writes scoped to distinct tenants, and each database
// must contain exactly its own row — never the other's. If somebody
// re-introduces the old bug and routes the writes through the shared
// pool, one of the two SELECTs below will come up empty (or double)
// and this test fails.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { auditAwait } from "../audit.ts";

let dbA: TestDb;
let dbB: TestDb;
let tenantA = "";
let tenantB = "";

describe("audit writer — pool isolation", () => {
  beforeAll(async () => {
    dbA = await createTestDb("audit-pool-a");
    dbB = await createTestDb("audit-pool-b");

    const [rowA] = await dbA.db
      .insert(tenants)
      .values({ slug: "pool-a", display_name: "Pool A" })
      .returning();
    const [rowB] = await dbB.db
      .insert(tenants)
      .values({ slug: "pool-b", display_name: "Pool B" })
      .returning();
    if (!rowA || !rowB) throw new Error("seed failed");
    tenantA = rowA.id;
    tenantB = rowB.id;
  });

  afterAll(async () => {
    await dbA.cleanup();
    await dbB.cleanup();
  });

  test("each audit call lands in the executor-bound database only", async () => {
    // Distinct action strings per tenant so SELECTs stay tight.
    await auditAwait(
      {
        tenant_id: tenantA,
        action: "tenant.created",
        resource_type: "tenant",
        resource_id: tenantA,
        result: "success",
        metadata: { pool: "a" },
      },
      dbA.db,
    );

    await auditAwait(
      {
        tenant_id: tenantB,
        action: "user.created",
        resource_type: "tenant",
        resource_id: tenantB,
        result: "success",
        metadata: { pool: "b" },
      },
      dbB.db,
    );

    // Query each database directly via raw SQL so we don't depend on a
    // drizzle table object that happens to share a schema instance.
    const aRows = await dbA.db.execute(
      sql`SELECT tenant_id::text AS tenant_id, action FROM audit_log`,
    );
    const bRows = await dbB.db.execute(
      sql`SELECT tenant_id::text AS tenant_id, action FROM audit_log`,
    );

    // `drizzle-orm/node-postgres` returns `{ rows }` on execute().
    const aList = (aRows as unknown as { rows: Array<{ tenant_id: string; action: string }> }).rows;
    const bList = (bRows as unknown as { rows: Array<{ tenant_id: string; action: string }> }).rows;

    // DB A must contain exactly the tenant-A write, nothing from B.
    expect(aList.length).toBe(1);
    expect(aList[0]?.tenant_id).toBe(tenantA);
    expect(aList[0]?.action).toBe("tenant.created");

    // DB B must contain exactly the tenant-B write, nothing from A.
    expect(bList.length).toBe(1);
    expect(bList[0]?.tenant_id).toBe(tenantB);
    expect(bList[0]?.action).toBe("user.created");
  });
});
