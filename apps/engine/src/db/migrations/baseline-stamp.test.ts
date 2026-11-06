import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { detectDrift, runMigrations, SQUASHED_CHAIN_HEAD_TAG } from "../migrate.ts";
import { createTestDb, type TestDb } from "../tests/setup.ts";
import { EMBEDDED_MIGRATIONS, type EmbeddedMigration } from "./embedded.ts";

const baseline = EMBEDDED_MIGRATIONS[0] as EmbeddedMigration;
const squashedTags = Array.from(
  { length: 151 },
  (_, idx) => `${String(idx).padStart(4, "0")}_squashed_${idx}`,
).concat(SQUASHED_CHAIN_HEAD_TAG);
const probe: EmbeddedMigration = {
  idx: EMBEDDED_MIGRATIONS.length,
  tag: "9999_baseline_stamp_probe",
  when: 1_900_000_000_000,
  hash: "baseline-stamp-probe-hash",
  statements: ["CREATE TABLE baseline_stamp_probe (id integer PRIMARY KEY)"],
};

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb("baseline-stamp");
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

async function replaceHistory(tags: readonly string[], untagged: number): Promise<void> {
  await ctx.db.execute(sql`DELETE FROM "subkit"."__drizzle_migrations"`);
  await ctx.db.execute(
    sql`INSERT INTO "subkit"."__drizzle_migrations" (hash, created_at, tag)
        SELECT md5('untagged-' || g), 0, NULL FROM generate_series(1, ${untagged}) AS g`,
  );
  for (const tag of tags)
    await ctx.db.execute(
      sql`INSERT INTO "subkit"."__drizzle_migrations" (hash, created_at, tag) VALUES (md5(${tag}), 0, ${tag})`,
    );
}

async function baselineRows(): Promise<number> {
  const rows = (await ctx.db.execute(
    sql`SELECT count(*)::int AS n FROM "subkit"."__drizzle_migrations" WHERE tag = ${baseline.tag}`,
  )) as unknown as { rows: Array<{ n: number }> };
  return rows.rows[0]?.n ?? 0;
}

async function probeSchema(): Promise<string[]> {
  const rows = (await ctx.db.execute(
    sql`SELECT schemaname FROM pg_tables WHERE tablename = 'baseline_stamp_probe'`,
  )) as unknown as { rows: Array<{ schemaname: string }> };
  return rows.rows.map((row) => row.schemaname);
}

describe("baseline over the squashed migration chain", () => {
  test("the bundle starts with the baseline followed by the post-squash migrations", () => {
    expect(EMBEDDED_MIGRATIONS.map((m) => m.tag)).toEqual([
      baseline.tag,
      "0001_hosted_meter_workflow_review_receipts",
    ]);
    expect(baseline.idx).toBe(0);
  });

  test("a database that stops before the chain head is refused and keeps its history", async () => {
    await replaceHistory(squashedTags.slice(0, 141), 0);
    await expect(runMigrations(ctx.db)).rejects.toThrow(SQUASHED_CHAIN_HEAD_TAG);
    expect(await baselineRows()).toBe(0);
  });

  test("a database at the chain head is stamped without DDL and applies only the post-squash migrations", async () => {
    await replaceHistory(squashedTags, 51);
    const stamped = await runMigrations(ctx.db);
    expect(stamped).toEqual({
      applied: EMBEDDED_MIGRATIONS.length - 1,
      skipped: 0,
      hash_drift_backfilled: 1,
      total: EMBEDDED_MIGRATIONS.length,
    });
    expect(await baselineRows()).toBe(1);
    const drift = await detectDrift(ctx.db);
    expect(drift.unknown_in_db).toEqual([]);
    expect(drift.missing_in_db).toEqual([]);
    expect(drift.historical_in_db).toHaveLength(squashedTags.length + 51);
    expect(await runMigrations(ctx.db)).toEqual({
      applied: 0,
      skipped: EMBEDDED_MIGRATIONS.length,
      hash_drift_backfilled: 0,
      total: EMBEDDED_MIGRATIONS.length,
    });
  });

  test("a tagged row recorded after the baseline is still unknown", async () => {
    await ctx.db.execute(
      sql`INSERT INTO "subkit"."__drizzle_migrations" (hash, created_at, tag) VALUES ('foreign-hash', 0, '9998_foreign_lineage')`,
    );
    const drift = await detectDrift(ctx.db);
    expect(drift.unknown_in_db.map((row) => row.tag)).toEqual(["9998_foreign_lineage"]);
    await ctx.db.execute(
      sql`DELETE FROM "subkit"."__drizzle_migrations" WHERE tag = '9998_foreign_lineage'`,
    );
  });

  test("an appended migration applies on the stamped database inside the product schema", async () => {
    expect(await probeSchema()).toEqual([]);
    const report = await runMigrations(ctx.db, [...EMBEDDED_MIGRATIONS, probe]);
    expect(report.applied).toBe(1);
    expect(await probeSchema()).toEqual(["subkit"]);
    expect((await runMigrations(ctx.db, [...EMBEDDED_MIGRATIONS, probe])).applied).toBe(0);
  });
});
