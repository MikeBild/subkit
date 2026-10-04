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
    expect(await turnCountColumnExists(ctx)).toBe(true);

    await ctx.db.execute(sql`ALTER TABLE conversations DROP COLUMN IF EXISTS turn_count`);
    await ctx.db.execute(
      sql`DELETE FROM subkit.__drizzle_migrations WHERE tag = '0001_condemned_maestro'`,
    );
    await ctx.db.execute(sql`UPDATE subkit.__drizzle_migrations SET tag = NULL`);
    await ctx.db.execute(
      sql`INSERT INTO subkit.__drizzle_migrations (hash, created_at, tag)
          SELECT md5(g::text), 0, NULL FROM generate_series(1, 50) AS g`,
    );

    const before = (await ctx.db.execute(
      sql`SELECT count(*)::int AS n FROM subkit.__drizzle_migrations`,
    )) as unknown as { rows: Array<{ n: number }> };
    expect(before.rows?.[0]?.n ?? 0).toBeGreaterThan(10);

    const report = await runMigrations(ctx.db);
    expect(report.applied).toBeGreaterThanOrEqual(1);
    expect(await turnCountColumnExists(ctx)).toBe(true);

    await runMigrations(ctx.db);
    expect(await turnCountColumnExists(ctx)).toBe(true);
  }, 60_000);
});
