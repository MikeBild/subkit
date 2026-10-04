import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import type { Executor } from "../../db/client.ts";
import { tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { _drainAuditWritesForTests, audit, auditAwait } from "../audit.ts";

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

    const aRows = await dbA.db.execute(
      sql`SELECT tenant_id::text AS tenant_id, action FROM audit_log`,
    );
    const bRows = await dbB.db.execute(
      sql`SELECT tenant_id::text AS tenant_id, action FROM audit_log`,
    );

    const aList = (aRows as unknown as { rows: Array<{ tenant_id: string; action: string }> }).rows;
    const bList = (bRows as unknown as { rows: Array<{ tenant_id: string; action: string }> }).rows;

    expect(aList.length).toBe(1);
    expect(aList[0]?.tenant_id).toBe(tenantA);
    expect(aList[0]?.action).toBe("tenant.created");

    expect(bList.length).toBe(1);
    expect(bList[0]?.tenant_id).toBe(tenantB);
    expect(bList[0]?.action).toBe("user.created");
  });

  test("executor-scoped drain ignores an unrelated stalled write", async () => {
    let releaseStalled!: () => void;
    const stalled = new Promise<void>((resolve) => {
      releaseStalled = resolve;
    });
    const fakeExecutor = (write: Promise<void>): Executor =>
      ({
        insert: () => ({
          values: () => ({ onConflictDoNothing: () => write }),
        }),
      }) as unknown as Executor;
    const stalledExecutor = fakeExecutor(stalled);
    const readyExecutor = fakeExecutor(Promise.resolve());

    audit(
      {
        tenant_id: tenantA,
        action: "tenant.created",
        resource_type: "tenant",
        resource_id: "stalled-write",
      },
      stalledExecutor,
    );
    audit(
      {
        tenant_id: tenantA,
        action: "tenant.created",
        resource_type: "tenant",
        resource_id: "ready-write",
      },
      readyExecutor,
    );

    await _drainAuditWritesForTests(readyExecutor);
    releaseStalled();
    await _drainAuditWritesForTests(stalledExecutor);
  });
});
