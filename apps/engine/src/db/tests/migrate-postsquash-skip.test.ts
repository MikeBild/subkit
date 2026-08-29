// Migration runner — a NEW migration must apply on a post-baseline-squash
// DB whose tracking table carries leftover pre-squash rows.
//
// The legacy upgrade bug (v7.7.0, 2026-06-22): the runner recognised an
// already-applied migration via a positional fallback — "if the tracking
// row COUNT already covers this migration's idx, treat it as applied".
// After the v6 baseline squash a long-lived DB still holds dozens of
// pre-squash rows, so `count` dwarfs the embedded set's idx
// range. Every genuinely-new migration was therefore positionally skipped:
// `0001_condemned_maestro` never ran, `conversations.turn_count` was never
// created, and the first real conversation turn would have thrown. Fresh
// Fresh databases start at count 0 and apply everything in order; this test
// closes the upgrade gap by reproducing the inflated-count state.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { runMigrations } from "../migrate.ts";
import { createTestDb, type TestDb } from "./setup.ts";

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb("migrate-postsquash-skip");
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

async function turnCountColumnExists(testDb: TestDb): Promise<boolean> {
  const rows = (await testDb.db.execute(
    sql`SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_name = 'conversations' AND column_name = 'turn_count'`,
  )) as unknown as { rows: Array<{ n: number }> };
  return (rows.rows?.[0]?.n ?? 0) > 0;
}

describe("migration runner — post-squash inflated tracking count", () => {
  test("a new migration applies even when the tracking table has more rows than the embedded set", async () => {
    // Sanity: createTestDb already applied 0001.
    expect(await turnCountColumnExists(ctx)).toBe(true);

    // Reconstruct the buggy legacy state:
    //  1. Undo 0001's schema effect (the column it was supposed to add).
    await ctx.db.execute(sql`ALTER TABLE conversations DROP COLUMN IF EXISTS turn_count`);
    //  2. Forget that 0001 was ever applied (drop its tracking row entirely).
    await ctx.db.execute(
      sql`DELETE FROM subkit.__drizzle_migrations WHERE tag = '0001_condemned_maestro'`,
    );
    //  3. Simulate a pre-tag-tracking DB: blank every tag (legacy rows predate
    //     the tag column) so the baseline is matched by hash, not tag.
    await ctx.db.execute(sql`UPDATE subkit.__drizzle_migrations SET tag = NULL`);
    //  4. Flood the table with pre-squash orphan rows so count >> idx — this
    //     is what made the old positional fallback fire and skip 0001.
    await ctx.db.execute(
      sql`INSERT INTO subkit.__drizzle_migrations (hash, created_at, tag)
          SELECT md5(g::text), 0, NULL FROM generate_series(1, 50) AS g`,
    );

    const before = (await ctx.db.execute(
      sql`SELECT count(*)::int AS n FROM subkit.__drizzle_migrations`,
    )) as unknown as { rows: Array<{ n: number }> };
    expect(before.rows?.[0]?.n ?? 0).toBeGreaterThan(10); // inflated count

    // The fix: tag-based identity. 0001 has no tag and no hash recorded, so
    // it is genuinely unapplied and MUST run despite the inflated count.
    const report = await runMigrations(ctx.db);
    expect(report.applied).toBeGreaterThanOrEqual(1);
    expect(await turnCountColumnExists(ctx)).toBe(true);

    // Idempotent: a second run recognises 0001 by tag and does not re-run it
    // (a re-run of `ADD COLUMN turn_count` would throw "already exists").
    await runMigrations(ctx.db);
    expect(await turnCountColumnExists(ctx)).toBe(true);
  }, 60_000);
});
