// LOCAL-SK-EXPORT-VERLIERT-ZEILEN — the ndjson export must contain every
// row of the snapshot it claims to cover.
//
// `streamAuditLog` walks the trail in 500-row batches and carries the
// batch boundary in a cursor. The cursor used to be the `ts` of the last
// row of the batch, compared with a strict `<`. Two things break that:
//
//   1. TIES. `audit()` stamps `ts` from the JS clock, so every row a
//      request writes in the same millisecond shares one `ts`. When a
//      batch boundary lands inside such a group, `ts < cursor` skips
//      every remaining member of the group — they are never emitted and
//      nothing reports a gap.
//
//   2. PRECISION. Postgres stores `timestamptz` to the microsecond; a JS
//      `Date` holds milliseconds. A row stored at `…04.755353Z` reads
//      back through the driver as `…04.755Z`, so a cursor built from the
//      driver value silently steps PAST up to 999µs of unread rows.
//
// Both are silent: the export ends normally, the file looks well-formed,
// and the missing rows are only visible against a count of the table.
// This test pins the export against exactly that count.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { streamAuditLog } from "../query.ts";

let testDb: TestDb;
let tenantId = "";

// Larger than the 500-row internal batch size, so the walk is forced to
// cross at least one cursor boundary.
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
        `('${crypto.randomUUID()}', timestamptz '${TIED_TS}', '${tenantId}', 'system',` +
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

    // The whole point: the export equals the snapshot. Before the keyset
    // fix this emitted 500 of 600.
    expect(seen.size).toBe(expected);
  });

  test("emits every row when timestamps differ only below millisecond resolution", async () => {
    // Sub-millisecond spacing — invisible to a JS Date cursor.
    const base = "2026-07-02T09:00:00.000000Z";
    const ids: string[] = [];
    for (let i = 1; i <= 40; i++) {
      const id = crypto.randomUUID();
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
});
