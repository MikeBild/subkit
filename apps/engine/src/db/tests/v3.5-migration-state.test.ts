// v3.5 migration state — assert the DB schema reflects the migration
// path. Catches a regression where:
//
//   - the migration runner skips 0009_drop_tenant_settings.sql
//   - someone re-adds the `tenants.settings` column to identity.ts
//   - a future migration accidentally re-creates the column
//
// Drizzle schema invariants:
//   - tenants table exists, has no `settings` column
//   - tenants_settings JSONB column is absent at the DB level
//
// The test runs against a fresh testcontainer Postgres so every migration
// applied. A drift here means the schema and the migration history have
// diverged.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { tenants } from "../schema/index.ts";
import { createTestDb, type TestDb } from "./setup.ts";

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb("v3.5-migration-state");
});

afterAll(async () => {
  await db.cleanup();
});

interface InfoSchemaRow {
  column_name?: string;
  table_name?: string;
}

describe("v3.5 migration state", () => {
  test("tenants.settings column was dropped (0009 migration ran)", async () => {
    const result = (await db.db.execute(sql`
      select column_name from information_schema.columns
      where table_schema = 'subkit'
        and table_name = 'tenants'
    `)) as unknown as { rows?: InfoSchemaRow[] } | InfoSchemaRow[];
    const rowList = Array.isArray(result) ? result : (result.rows ?? []);
    const cols = rowList.map((r) => r.column_name).filter((c): c is string => !!c);
    expect(cols).not.toContain("settings");
    // Sanity: tenants table itself wasn't dropped.
    expect(cols).toContain("id");
    expect(cols).toContain("slug");
  });

  test("Drizzle TS schema for tenants does not declare a settings column", () => {
    const cols = Object.keys(tenants);
    expect(cols).not.toContain("settings");
  });

  test("engine_settings table is retained (carries the bootstrap sentinel keys)", async () => {
    const result = (await db.db.execute(sql`
      select table_name from information_schema.tables
      where table_schema = 'subkit' and table_name = 'engine_settings'
    `)) as unknown as { rows?: InfoSchemaRow[] } | InfoSchemaRow[];
    const rowList = Array.isArray(result) ? result : (result.rows ?? []);
    const tables = rowList.map((r) => r.table_name).filter((c): c is string => !!c);
    expect(tables).toContain("engine_settings");
  });
});
