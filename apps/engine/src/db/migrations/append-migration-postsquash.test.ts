// Regression guard for the post-squash positional-skip migration bug (fixed in
// v7.7.1): a NEW migration appended to the embedded set must apply on a DB whose
// `__drizzle_migrations` is in the exact prod shape — embedded rows tag-stamped,
// plus a flood of pre-squash ORPHAN rows (tag NULL) that inflate the row count
// far past the embedded idx range. The old runner used a positional fallback
// ("row COUNT already covers this idx → treat as applied → skip"), which
// silently skipped genuinely-new migrations once the count outgrew their idx.
// v7.7.1 replaced that with tag-membership identity (applied iff tag recorded).
//
// Crucially this drives the REAL `runMigrations` (via its test-only `migrations`
// seam) — NOT a hand-copy of the loop — so if the runner ever regresses back to
// the positional fallback, this test fails for real:
//   - the synthetic migration's idx is BELOW the inflated count, so a positional
//     check (count > idx) would skip it → its non-IF-NOT-EXISTS CREATE TABLE
//     never runs → the table-exists assertion fails.
//   - tag-membership semantics instead apply it once and skip it on re-run; a
//     re-run regression would re-execute the CREATE TABLE and throw
//     "relation already exists".

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { detectDrift, runMigrations } from "../migrate.ts";
import { createTestDb, type TestDb } from "../tests/setup.ts";
import { EMBEDDED_MIGRATIONS, type EmbeddedMigration } from "./embedded.ts";

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb("append-migration-postsquash");
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

async function syntheticTableExists(testDb: TestDb): Promise<boolean> {
  const rows = (await testDb.db.execute(
    sql`SELECT count(*)::int AS n FROM information_schema.tables
        WHERE table_name = 'append_postsquash_probe'`,
  )) as unknown as { rows: Array<{ n: number }> };
  return (rows.rows?.[0]?.n ?? 0) > 0;
}

async function rowCount(testDb: TestDb, where: ReturnType<typeof sql>): Promise<number> {
  const rows = (await testDb.db.execute(
    sql`SELECT count(*)::int AS n FROM "drizzle"."__drizzle_migrations" WHERE ${where}`,
  )) as unknown as { rows: Array<{ n: number }> };
  return rows.rows?.[0]?.n ?? 0;
}

describe("appended migration — post-squash inflated count + orphan tag-NULL rows", () => {
  test("a new appended migration applies via the real runner despite inflated count, and is idempotent by tag", async () => {
    // Reproduce the prod tracking shape: embedded rows stay tag-stamped (as
    // createTestDb left them), plus ~50 pre-squash ORPHAN rows with NULL tags
    // that inflate the count past any embedded idx — exactly what made the old
    // positional fallback fire.
    await ctx.db.execute(
      sql`INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at, tag)
          SELECT md5(g::text), 0, NULL FROM generate_series(1, 50) AS g`,
    );
    const totalRows = await rowCount(ctx, sql`true`);
    expect(totalRows).toBeGreaterThan(EMBEDDED_MIGRATIONS.length + 40);
    const prodShapeDrift = await detectDrift(ctx.db);
    expect(prodShapeDrift.unknown_in_db).toEqual([]);
    expect(prodShapeDrift.historical_in_db).toHaveLength(50);
    expect(prodShapeDrift.missing_in_db).toEqual([]);

    // Synthetic appended migration: idx BELOW the inflated count (so a
    // positional regression would wrongly skip it), fresh tag/hash absent from
    // the table, non-idempotent CREATE TABLE.
    const synthetic: EmbeddedMigration = {
      idx: EMBEDDED_MIGRATIONS.length, // next sequential idx — far below totalRows
      tag: "9999_append_postsquash_probe",
      when: 1_900_000_000_000,
      hash: "append-postsquash-probe-hash-not-in-table",
      statements: ["CREATE TABLE append_postsquash_probe (id integer PRIMARY KEY)"],
    };
    expect(synthetic.idx).toBeLessThan(totalRows);
    expect(await syntheticTableExists(ctx)).toBe(false);

    // First run through the REAL runner with the embedded set + the appended
    // migration. Embedded tags are already recorded → skipped; the synthetic is
    // tag-absent → applied despite count >> idx.
    const first = await runMigrations(ctx.db, [...EMBEDDED_MIGRATIONS, synthetic]);
    expect(first.applied).toBe(1);
    expect(await syntheticTableExists(ctx)).toBe(true);
    expect(await rowCount(ctx, sql`tag = ${synthetic.tag}`)).toBe(1);

    // Second run: recognised by tag → no-op. A re-run of the non-IF-NOT-EXISTS
    // CREATE TABLE would throw "relation already exists", so completing without
    // throwing is the proof of tag-based idempotency.
    const second = await runMigrations(ctx.db, [...EMBEDDED_MIGRATIONS, synthetic]);
    expect(second.applied).toBe(0);
    expect(await syntheticTableExists(ctx)).toBe(true);
    expect(await rowCount(ctx, sql`tag = ${synthetic.tag}`)).toBe(1);
  }, 60_000);
});
