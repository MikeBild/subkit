// Migration runner — idempotency + hash-drift recovery.
//
// Reproduces the real bug we hit in production: drizzle-orm's stock
// migrator skipped migrations silently when journal timestamps were
// non-monotonic ("reported success, applied nothing"). Our custom
// migrator identifies an applied migration by its stable `tag` (a row in
// `subkit.__drizzle_migrations`), so an edited .sql backfills its hash
// without re-running, and a genuinely-new migration always applies.
//
// Scope:
//   1. re-running the migrator on an already-migrated DB is a no-op
//   2. hash drift (someone edits a .sql after it was applied) is
//      handled by backfilling the stored hash without re-running SQL
//   3. back-to-back runs complete without errors

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { runMigrations } from "../migrate.ts";
import { createTestDb, type TestDb } from "./setup.ts";

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb("migrate-idempotency");
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

async function rowCount(testDb: TestDb): Promise<number> {
  const rows = (await testDb.db.execute(
    sql`SELECT count(*)::int AS n FROM subkit.__drizzle_migrations`,
  )) as unknown as { rows: Array<{ n: number }> };
  return rows.rows?.[0]?.n ?? 0;
}

describe("migration runner", () => {
  test("createTestDb left the tracking table populated", async () => {
    const n = await rowCount(ctx);
    // After the v3 baseline consolidation, a fresh DB has exactly one
    // row (the baseline). Pre-consolidation it had 24+ — we keep the
    // assertion lower bound at 1 so the test stays green on both.
    expect(n).toBeGreaterThanOrEqual(1);
  });

  test("re-running runMigrations on an up-to-date DB is a no-op", async () => {
    const before = await rowCount(ctx);
    await runMigrations(ctx.db); // must not throw, must not change row count
    const after = await rowCount(ctx);
    expect(after).toBe(before);
  }, 30_000);

  test("hash drift — a mutated stored hash is backfilled, not re-applied", async () => {
    // Mutate the highest-id row's stored hash. runMigrations should
    // still recognise the migration by its `tag` (unchanged) — so it
    // updates the stored hash back to the current file hash and returns
    // without re-running the SQL.
    await ctx.db.execute(
      sql`UPDATE subkit.__drizzle_migrations SET hash = 'deadbeef_fake_hash_drift' WHERE id = (SELECT max(id) FROM subkit.__drizzle_migrations)`,
    );
    const before = await rowCount(ctx);
    await runMigrations(ctx.db); // must not throw
    const after = await rowCount(ctx);
    expect(after).toBe(before);
    const stale = (await ctx.db.execute(
      sql`SELECT count(*)::int AS n FROM subkit.__drizzle_migrations WHERE hash = 'deadbeef_fake_hash_drift'`,
    )) as unknown as { rows: Array<{ n: number }> };
    expect(stale.rows?.[0]?.n ?? 0).toBe(0);
  }, 30_000);

  test("back-to-back runs complete without error", async () => {
    await runMigrations(ctx.db);
    await runMigrations(ctx.db);
  }, 60_000);
});
