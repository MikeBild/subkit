import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { queryAuditLog, streamAuditLog } from "../query.ts";

const uuid = createDeterministicUuidFactory(0x5ec7e7);

let testDb: TestDb;
let tenantId = "";

const TIED_ROWS = 600;
const TIED_TS = "2026-07-01T09:00:00.000000Z";

describe("audit export — completeness against the table snapshot", () => {
  beforeAll(async () => {
    testDb = await createTestDb("audit-export-completeness");
    const [row] = await testDb.db
      .insert(tenants)
      .values({ slug: "export-tenant", display_name: "Export Tenant" })
      .returning();
    if (!row) throw new Error("seed failed");
    tenantId = row.id;
  });

  afterAll(async () => {
    await testDb.cleanup();
  });

  test("emits every row when the batch boundary falls inside a tie group", async () => {
    const values = Array.from(
      { length: TIED_ROWS },
      () =>
        `('${uuid()}', timestamptz '${TIED_TS}', '${tenantId}', 'system',` +
        ` 'system.startup', 'system', 'success', '{}'::jsonb)`,
    );
    await testDb.pool.query(
      `INSERT INTO audit_log (id, ts, tenant_id, actor_type, action, resource_type, result, metadata)
       VALUES ${values.join(",")}`,
    );

    const snapshot = await testDb.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1`,
      [tenantId],
    );
    const expected = snapshot.rows[0]?.n ?? 0;
    expect(expected).toBe(TIED_ROWS);

    const seen = new Set<string>();
    for await (const entry of streamAuditLog(testDb.db, { tenant_id: tenantId })) {
      seen.add(entry.id);
    }

    expect(seen.size).toBe(expected);
  });

  test("emits every row when timestamps differ only below millisecond resolution", async () => {
    const base = "2026-07-02T09:00:00.000000Z";
    const ids: string[] = [];
    for (let i = 1; i <= 40; i++) {
      const id = uuid();
      ids.push(id);
      await testDb.pool.query(
        `INSERT INTO audit_log (id, ts, tenant_id, actor_type, action, resource_type, result, metadata)
         VALUES ($1, timestamptz '${base}' + ($2 || ' microseconds')::interval, $3,
                 'system', 'system.startup', 'system', 'success', '{}'::jsonb)`,
        [id, String(i * 10), tenantId],
      );
    }

    const seen = new Set<string>();
    for await (const entry of streamAuditLog(testDb.db, {
      tenant_id: tenantId,
      ts_from: new Date("2026-07-02T08:00:00Z"),
      ts_to: new Date("2026-07-02T10:00:00Z"),
    })) {
      seen.add(entry.id);
    }

    for (const id of ids) expect(seen.has(id)).toBe(true);
    expect(seen.size).toBe(ids.length);
  });

  test("a full paged walk returns every row, with ties and sub-ms spacing", async () => {
    const [walkTenant] = await testDb.db
      .insert(tenants)
      .values({ slug: "list-walk-tenant", display_name: "List Walk" })
      .returning();
    if (!walkTenant) throw new Error("seed failed");

    for (let i = 0; i < 10; i++) {
      await testDb.pool.query(
        `INSERT INTO audit_log (id, ts, tenant_id, actor_type, action, resource_type, result, metadata)
         VALUES ($1, timestamptz '2026-09-01T12:00:00.000000Z', $2, 'system', 'system.startup', 'system', 'success', '{}'::jsonb)`,
        [uuid(), walkTenant.id],
      );
    }
    for (let i = 1; i <= 5; i++) {
      await testDb.pool.query(
        `INSERT INTO audit_log (id, ts, tenant_id, actor_type, action, resource_type, result, metadata)
         VALUES ($1, timestamptz '2026-09-01T12:00:01.000000Z' + ($2 || ' microseconds')::interval,
                 $3, 'system', 'system.startup', 'system', 'success', '{}'::jsonb)`,
        [uuid(), String(i * 100), walkTenant.id],
      );
    }

    const snapshot = await testDb.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1`,
      [walkTenant.id],
    );
    const expected = snapshot.rows[0]?.n ?? 0;
    expect(expected).toBe(15);

    const seen = new Set<string>();
    let before: string | undefined;
    let pages = 0;
    while (pages < 50) {
      const res = await queryAuditLog(
        testDb.db,
        { tenant_id: walkTenant.id },
        before === undefined ? { limit: 3 } : { limit: 3, cursor: before },
      );
      for (const row of res.items) seen.add(row.id);
      pages++;
      if (!res.next_cursor) break;
      before = res.next_cursor;
    }

    expect(seen.size).toBe(expected);
    expect(pages).toBeLessThanOrEqual(6);
  });
});
