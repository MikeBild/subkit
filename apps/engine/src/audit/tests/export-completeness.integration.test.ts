// LOCAL-SK-EXPORT-VERLIERT-ZEILEN / LOCAL-SK-EINE-REGEL-ZWEI-LESEPFADE —
// EVERY cursor read path over `audit_log` must return every row of the
// snapshot it claims to cover. There are exactly two: `streamAuditLog`
// (the ndjson export) and `queryAuditLog` (the paged list). Both are
// pinned here, in one file, because it is ONE rule — the first round
// fixed only the export and the list kept losing 9 of 15.
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
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { queryAuditLog, streamAuditLog } from "../query.ts";

const uuid = createDeterministicUuidFactory(0x5ec7e7);

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

    // The whole point: the export equals the snapshot. Before the keyset
    // fix this emitted 500 of 600.
    expect(seen.size).toBe(expected);
  });

  test("emits every row when timestamps differ only below millisecond resolution", async () => {
    // Sub-millisecond spacing — invisible to a JS Date cursor.
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

  // Second reader, same rule. `queryAuditLog` is what GET /v1/audit-log
  // and the cockpit audit page walk, so a row lost here is a row an
  // operator paging the trail never sees — and the list gives no sign it
  // skipped anything, it simply ends.
  test("a full paged walk returns every row, with ties and sub-ms spacing", async () => {
    const [walkTenant] = await testDb.db
      .insert(tenants)
      .values({ slug: "list-walk-tenant", display_name: "List Walk" })
      .returning();
    if (!walkTenant) throw new Error("seed failed");

    // 10 rows sharing ONE timestamp (one request's worth of audit rows),
    // plus 5 spaced by microseconds only — invisible to a JS Date.
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

    // Page size 3 forces boundaries to land inside the tie group.
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

    // Before the keyset cursor reached this path: 6 of 15.
    expect(seen.size).toBe(expected);
    // 15 rows at page size 3 is 5 full pages + one short page; anything
    // more means rows were served twice.
    expect(pages).toBeLessThanOrEqual(6);
  });
});
