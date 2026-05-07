// End-to-end check that a fresh database, given only `runMigrations(db)`,
// reaches the schema state the rest of the engine expects.
//
// Issue #149 was a "schema mismatch the engine quietly logs and keeps
// going" story; this test fails loudly if a future refactor breaks the
// embedded-bundle path on a clean DB.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { listEmbeddedMigrations, runMigrations } from "../migrate.ts";
import { createTestDb, type TestDb } from "./setup.ts";

let ctx: TestDb;

beforeAll(async () => {
  // createTestDb already runs `runMigrations(db)`; this gives us a
  // fully-migrated DB to inspect.
  ctx = await createTestDb("migrate_fresh_db");
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

interface ExistsRow {
  rows: Array<{ exists: boolean }>;
}

async function tableExists(name: string): Promise<boolean> {
  const r = (await ctx.db.execute(
    sql`SELECT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = ${name}
        ) AS "exists"`,
  )) as unknown as ExistsRow;
  return Boolean(r.rows?.[0]?.exists);
}

describe("runMigrations on a fresh database", () => {
  test("creates the workflow_waits table that #149 reported missing", async () => {
    expect(await tableExists("workflow_waits")).toBe(true);
  });

  test("creates every other top-level expected table", async () => {
    const expected = [
      "tenants",
      "users",
      "system_accounts",
      "api_keys",
      "skills",
      "connectors",
      "workflows",
      "executions",
      "audit_log",
      "credentials",
    ];
    for (const t of expected) {
      expect(await tableExists(t)).toBe(true);
    }
  });

  test("drizzle.__drizzle_migrations row count equals embedded entry count", async () => {
    const r = (await ctx.db.execute(
      sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`,
    )) as unknown as { rows: Array<{ n: number }> };
    expect(r.rows?.[0]?.n).toBe(listEmbeddedMigrations().length);
  });

  test("re-running runMigrations is a no-op", async () => {
    const before = (await ctx.db.execute(
      sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`,
    )) as unknown as { rows: Array<{ n: number }> };
    const report = await runMigrations(ctx.db);
    expect(report.applied).toBe(0);
    expect(report.skipped).toBe(listEmbeddedMigrations().length);
    const after = (await ctx.db.execute(
      sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`,
    )) as unknown as { rows: Array<{ n: number }> };
    expect(after.rows?.[0]?.n).toBe(before.rows?.[0]?.n);
  });
});
