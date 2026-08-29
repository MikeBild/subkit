// Migration runner — concurrent-boot safety (#20).
//
// Two engine instances booting against the same database both call
// runMigrations. Without a cross-process lock both can read "this
// migration is not applied yet" and both run its non-idempotent DDL —
// the second throws "relation already exists". runMigrations now holds a
// session-level Postgres advisory lock on a dedicated connection for the
// whole apply, so concurrent runs serialize: exactly one applies, the
// other sees the committed state and skips.

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
    // Non-idempotent CREATE TABLE: if the advisory lock fails to serialize,
    // the loser re-runs this and throws "relation already exists".
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

    // Exactly one of the two runs actually applied the migration.
    expect(r1.applied + r2.applied).toBe(1);

    // The table exists, and its tracking row was written exactly once.
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
