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
    expect(n).toBeGreaterThanOrEqual(1);
  });

  test("re-running runMigrations on an up-to-date DB is a no-op", async () => {
    const before = await rowCount(ctx);
    await runMigrations(ctx.db);
    const after = await rowCount(ctx);
    expect(after).toBe(before);
  }, 30_000);

  test("hash drift — a mutated stored hash is backfilled, not re-applied", async () => {
    await ctx.db.execute(
      sql`UPDATE subkit.__drizzle_migrations SET hash = 'deadbeef_fake_hash_drift' WHERE id = (SELECT max(id) FROM subkit.__drizzle_migrations)`,
    );
    const before = await rowCount(ctx);
    await runMigrations(ctx.db);
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
