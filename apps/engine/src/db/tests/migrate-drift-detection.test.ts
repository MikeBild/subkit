// Drift detection — surfaces the actionable signal a silent schema mismatch otherwise hides.
//
// We seed `subkit.__drizzle_migrations` with rows that don't belong
// to this binary's embedded set and confirm `detectDrift` reports them.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { detectDrift, listEmbeddedMigrations } from "../migrate.ts";
import { createTestDb, type TestDb } from "./setup.ts";

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb("migrate_drift");
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

describe("detectDrift", () => {
  test("clean DB reports no drift", async () => {
    const report = await detectDrift(ctx.db);
    expect(report.unknown_in_db).toEqual([]);
    expect(report.historical_in_db).toEqual([]);
    expect(report.missing_in_db).toEqual([]);
  });

  test("an unknown tagged row in the journal surfaces in unknown_in_db", async () => {
    const fakeHash = "deadbeefcafebabefacefeed".padEnd(64, "0");
    await ctx.db.execute(
      sql`INSERT INTO "subkit"."__drizzle_migrations" ("hash", "created_at", "tag")
          VALUES (${fakeHash}, ${999_999_999_999}, ${"9999_foreign_lineage"})`,
    );

    const report = await detectDrift(ctx.db);
    const unknownHashes = report.unknown_in_db.map((r) => r.hash);
    expect(unknownHashes).toContain(fakeHash);
    expect(report.historical_in_db).toEqual([]);
    // Sanity: the embedded set is still considered fully applied.
    expect(report.missing_in_db).toEqual([]);

    // Cleanup so the next test runs against a clean ring.
    await ctx.db.execute(sql`DELETE FROM "subkit"."__drizzle_migrations" WHERE hash = ${fakeHash}`);
  });

  test("a tagless pre-squash row is accepted history rather than drift", async () => {
    const historicalHash = "pre-squash-history".padEnd(64, "0");
    await ctx.db.execute(
      sql`INSERT INTO "subkit"."__drizzle_migrations" ("hash", "created_at", "tag")
          VALUES (${historicalHash}, ${999_999_999_998}, NULL)`,
    );
    try {
      const report = await detectDrift(ctx.db);
      expect(report.unknown_in_db).toEqual([]);
      expect(report.historical_in_db.map((r) => r.hash)).toContain(historicalHash);
      expect(report.missing_in_db).toEqual([]);
    } finally {
      await ctx.db.execute(
        sql`DELETE FROM "subkit"."__drizzle_migrations" WHERE hash = ${historicalHash}`,
      );
    }
  });

  test("a deleted row surfaces in missing_in_db", async () => {
    // Drop the most recently applied embedded migration row.
    const lastTag = listEmbeddedMigrations().at(-1)!.tag;
    await ctx.db.execute(
      sql`DELETE FROM "subkit"."__drizzle_migrations"
          WHERE id = (SELECT max(id) FROM subkit.__drizzle_migrations)`,
    );
    const report = await detectDrift(ctx.db);
    expect(report.missing_in_db.map((m) => m.tag)).toContain(lastTag);
  });
});
