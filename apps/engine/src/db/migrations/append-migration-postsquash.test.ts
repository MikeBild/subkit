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
    sql`SELECT count(*)::int AS n FROM "subkit"."__drizzle_migrations" WHERE ${where}`,
  )) as unknown as { rows: Array<{ n: number }> };
  return rows.rows?.[0]?.n ?? 0;
}

describe("appended migration — post-squash inflated count + orphan tag-NULL rows", () => {
  test("a new appended migration applies via the real runner despite inflated count, and is idempotent by tag", async () => {
    await ctx.db.execute(
      sql`INSERT INTO "subkit"."__drizzle_migrations" (hash, created_at, tag)
          SELECT md5(g::text), 0, NULL FROM generate_series(1, 50) AS g`,
    );
    const totalRows = await rowCount(ctx, sql`true`);
    expect(totalRows).toBeGreaterThan(EMBEDDED_MIGRATIONS.length + 40);
    const legacyShapeDrift = await detectDrift(ctx.db);
    expect(legacyShapeDrift.unknown_in_db).toEqual([]);
    expect(legacyShapeDrift.historical_in_db).toHaveLength(50);
    expect(legacyShapeDrift.missing_in_db).toEqual([]);

    const synthetic: EmbeddedMigration = {
      idx: EMBEDDED_MIGRATIONS.length,
      tag: "9999_append_postsquash_probe",
      when: 1_900_000_000_000,
      hash: "append-postsquash-probe-hash-not-in-table",
      statements: ["CREATE TABLE append_postsquash_probe (id integer PRIMARY KEY)"],
    };
    expect(synthetic.idx).toBeLessThan(totalRows);
    expect(await syntheticTableExists(ctx)).toBe(false);

    const first = await runMigrations(ctx.db, [...EMBEDDED_MIGRATIONS, synthetic]);
    expect(first.applied).toBe(1);
    expect(await syntheticTableExists(ctx)).toBe(true);
    expect(await rowCount(ctx, sql`tag = ${synthetic.tag}`)).toBe(1);

    const second = await runMigrations(ctx.db, [...EMBEDDED_MIGRATIONS, synthetic]);
    expect(second.applied).toBe(0);
    expect(await syntheticTableExists(ctx)).toBe(true);
    expect(await rowCount(ctx, sql`tag = ${synthetic.tag}`)).toBe(1);
  }, 60_000);
});
