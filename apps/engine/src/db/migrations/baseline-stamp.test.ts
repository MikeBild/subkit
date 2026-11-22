import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { schemaAheadTags, schemaBehindChainHead } from "../../preflight/index.ts";
import {
  detectDrift,
  RETIRED_BASELINE_TAGS,
  runMigrations,
  SQUASHED_CHAIN_HEAD_TAG,
} from "../migrate.ts";
import { createTestDb, type TestDb } from "../tests/setup.ts";
import { EMBEDDED_MIGRATIONS, type EmbeddedMigration } from "./embedded.ts";

const baseline = EMBEDDED_MIGRATIONS[0] as EmbeddedMigration;
const tagOf = (idx: number, name: string) => `${String(idx).padStart(4, "0")}_${name}`;
const retiredChain = Array.from({ length: 151 }, (_, idx) => tagOf(idx, `retired_${idx}`));
const replacedChain = Array.from({ length: 22 }, (_, idx) => tagOf(idx + 1, `replaced_${idx + 1}`));
const oldLineage = [
  ...retiredChain,
  ...RETIRED_BASELINE_TAGS,
  ...replacedChain,
  SQUASHED_CHAIN_HEAD_TAG,
];
const staleLineage = oldLineage.slice(0, oldLineage.length - 8);
const UNTAGGED = 51;
const probe: EmbeddedMigration = {
  idx: EMBEDDED_MIGRATIONS.length,
  tag: "9999_baseline_stamp_probe",
  when: 1_900_000_000_000,
  hash: "baseline-stamp-probe-hash",
  statements: ["CREATE TABLE baseline_stamp_probe (id integer PRIMARY KEY)"],
};
const reused: EmbeddedMigration = {
  idx: EMBEDDED_MIGRATIONS.length,
  tag: replacedChain[3] as string,
  when: 1_900_000_000_000,
  hash: "baseline-reused-tag-hash",
  statements: ["CREATE TABLE baseline_reused_tag_probe (id integer PRIMARY KEY)"],
};

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb("baseline-stamp");
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

async function atChainHead(): Promise<void> {
  await ctx.cleanup();
  ctx = await createTestDb("baseline-stamp", [baseline]);
  await replaceHistory(oldLineage, UNTAGGED);
}

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

async function count(where = sql`true`): Promise<number> {
  const rows = (await ctx.db.execute(
    sql`SELECT count(*)::int AS n FROM "subkit"."__drizzle_migrations" WHERE ${where}`,
  )) as unknown as { rows: Array<{ n: number }> };
  return rows.rows[0]?.n ?? 0;
}

const baselineRows = () => count(sql`tag = ${baseline.tag}`);

async function tableSchemas(table: string): Promise<string[]> {
  const rows = (await ctx.db.execute(
    sql`SELECT schemaname FROM pg_tables WHERE tablename = ${table}`,
  )) as unknown as { rows: Array<{ schemaname: string }> };
  return rows.rows.map((row) => row.schemaname);
}

describe("baseline over the replaced migration chain", () => {
  test("the bundle starts with the baseline and retires the replaced baselines", () => {
    expect(baseline.idx).toBe(0);
    expect(RETIRED_BASELINE_TAGS.length).toBeGreaterThan(0);
    expect(RETIRED_BASELINE_TAGS).not.toContain(baseline.tag);
  });

  test("a database that stops before the chain head is refused and keeps its history", async () => {
    await replaceHistory(staleLineage, UNTAGGED);
    await expect(runMigrations(ctx.db)).rejects.toThrow(SQUASHED_CHAIN_HEAD_TAG);
    expect(await baselineRows()).toBe(0);
    expect(await count()).toBe(staleLineage.length + UNTAGGED);
    expect(await schemaBehindChainHead(ctx.db)).toBe(SQUASHED_CHAIN_HEAD_TAG);
  });

  test("a database with only a retired baseline is refused instead of passing as hash drift", async () => {
    await replaceHistory(RETIRED_BASELINE_TAGS, 0);
    await expect(runMigrations(ctx.db)).rejects.toThrow(SQUASHED_CHAIN_HEAD_TAG);
    expect(await baselineRows()).toBe(0);
    expect(await count()).toBe(RETIRED_BASELINE_TAGS.length);
    expect(await schemaBehindChainHead(ctx.db)).toBe(SQUASHED_CHAIN_HEAD_TAG);
  });

  test("the boot preflight accepts the replaced chain before and after the stamp and still refuses newer tags", async () => {
    await atChainHead();
    expect(await schemaAheadTags(ctx.db)).toEqual([]);
    expect(await schemaBehindChainHead(ctx.db)).toBeNull();
    await runMigrations(ctx.db);
    expect(await baselineRows()).toBe(1);
    expect(await schemaAheadTags(ctx.db)).toEqual([]);
    expect(await schemaBehindChainHead(ctx.db)).toBeNull();
    await ctx.db.execute(
      sql`INSERT INTO "subkit"."__drizzle_migrations" (hash, created_at, tag) VALUES (md5('future'), 0, '9998_from_a_newer_release')`,
    );
    expect(await schemaAheadTags(ctx.db)).toEqual(["9998_from_a_newer_release"]);
  });

  test("a database at the chain head is stamped without DDL and applies only what follows the baseline", async () => {
    await atChainHead();
    expect(await runMigrations(ctx.db)).toEqual({
      applied: EMBEDDED_MIGRATIONS.length - 1,
      skipped: 0,
      hash_drift_backfilled: 1,
      total: EMBEDDED_MIGRATIONS.length,
    });
    expect(await baselineRows()).toBe(1);
    const drift = await detectDrift(ctx.db);
    expect(drift.unknown_in_db).toEqual([]);
    expect(drift.missing_in_db).toEqual([]);
    expect(drift.historical_in_db).toHaveLength(oldLineage.length + UNTAGGED);
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
    expect(await tableSchemas("baseline_stamp_probe")).toEqual([]);
    const report = await runMigrations(ctx.db, [...EMBEDDED_MIGRATIONS, probe]);
    expect(report.applied).toBe(1);
    expect(await tableSchemas("baseline_stamp_probe")).toEqual(["subkit"]);
    expect((await runMigrations(ctx.db, [...EMBEDDED_MIGRATIONS, probe])).applied).toBe(0);
  });

  test("a tag from the replaced chain never hides a new migration, not even in the stamping run", async () => {
    await atChainHead();
    expect(await tableSchemas("baseline_reused_tag_probe")).toEqual([]);
    const report = await runMigrations(ctx.db, [...EMBEDDED_MIGRATIONS, reused]);
    expect(report).toEqual({
      applied: EMBEDDED_MIGRATIONS.length,
      skipped: 0,
      hash_drift_backfilled: 1,
      total: EMBEDDED_MIGRATIONS.length + 1,
    });
    expect(await tableSchemas("baseline_reused_tag_probe")).toEqual(["subkit"]);
    expect(await count(sql`tag = ${reused.tag}`)).toBe(2);
    expect((await runMigrations(ctx.db, [...EMBEDDED_MIGRATIONS, reused])).applied).toBe(0);
  });
});
