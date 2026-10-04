import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { runMigrations } from "../migrate.ts";
import { EMBEDDED_MIGRATIONS, type EmbeddedMigration } from "../migrations/embedded.ts";
import { createTestDb, type TestDb } from "./setup.ts";

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb("migrate-concurrency");
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

describe("migration runner — concurrency", () => {
  test("two concurrent runs apply a new migration exactly once", async () => {
    const synthetic: EmbeddedMigration = {
      idx: EMBEDDED_MIGRATIONS.length,
      tag: "9999_concurrency_probe",
      when: 1_900_000_000_001,
      hash: "migrate-concurrency-probe-hash",
      statements: ["CREATE TABLE migrate_concurrency_probe (id integer PRIMARY KEY)"],
    };

    const [r1, r2] = await Promise.all([
      runMigrations(ctx.db, [synthetic]),
      runMigrations(ctx.db, [synthetic]),
    ]);

    expect(r1.applied + r2.applied).toBe(1);

    const tbl = (await ctx.db.execute(
      sql`SELECT count(*)::int AS n FROM information_schema.tables
          WHERE table_name = 'migrate_concurrency_probe'`,
    )) as unknown as { rows: Array<{ n: number }> };
    expect(tbl.rows?.[0]?.n ?? 0).toBe(1);

    const tracked = (await ctx.db.execute(
      sql`SELECT count(*)::int AS n FROM "subkit"."__drizzle_migrations" WHERE tag = ${synthetic.tag}`,
    )) as unknown as { rows: Array<{ n: number }> };
    expect(tracked.rows?.[0]?.n ?? 0).toBe(1);
  }, 60_000);
});
