import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { PLATFORM_TABLES } from "../../identity/tenant-erasure-tables.ts";
import { schedulerSweepCursors, schedulerSweepProducerEnum } from "../schema/index.ts";
import { createTestDb, type TestDb } from "../tests/setup.ts";
import { EMBEDDED_MIGRATIONS } from "./embedded.ts";

const migration = EMBEDDED_MIGRATIONS.find((item) => item.idx === 0);
const expected: typeof schedulerSweepProducerEnum.enumValues = [
  "catalog",
  "docs",
  "workflow-cron",
  "drift",
  "reauth",
  "endpoint-contract",
  "knowledge",
  "skill",
];
let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb("scheduler-cursor-constraints");
});

afterAll(async () => {
  await ctx?.cleanup();
});

test("migration stays embedded and seeds precisely the closed producer set", async () => {
  if (!migration) throw new Error("scheduler_sweep_migration_missing");
  const body = readFileSync(join(import.meta.dir, `${migration.tag}.sql`), "utf8");
  expect(migration.hash).toBe(createHash("sha256").update(body).digest("hex"));
  expect(schedulerSweepProducerEnum.enumValues).toEqual(expected);
  const snapshot = JSON.parse(
    readFileSync(
      join(import.meta.dir, `meta/${String(migration.idx).padStart(4, "0")}_snapshot.json`),
      "utf8",
    ),
  ) as { enums: Record<string, { values: string[] }> };
  const values = snapshot.enums["public.scheduler_sweep_producer"]?.values;
  if (!values) throw new Error("scheduler_sweep_producers_missing");
  expect(values).toEqual(expected);
  const rows = await ctx.db.select().from(schedulerSweepCursors);
  expect(rows.map((row) => row.producer).sort()).toEqual([...expected].sort());
  for (const row of rows) {
    expect(row).toMatchObject({
      epoch: 0,
      revision: 0,
      after_id: null,
      epoch_upper_id: null,
      epoch_cutoff_at: null,
      lease_owner_boot_id: null,
      lease_token: null,
      lease_until: null,
    });
  }
  const precision = await ctx.pool.query(
    "SELECT datetime_precision FROM information_schema.columns WHERE table_schema='subkit' AND table_name='scheduler_sweep_cursors' AND column_name IN ('epoch_cutoff_at','lease_until','updated_at')",
  );
  expect(precision.rows.map((row) => row.datetime_precision)).toEqual([3, 3, 3]);
  await expect(
    ctx.pool.query("INSERT INTO subkit.scheduler_sweep_cursors(producer) VALUES ('catalog')"),
  ).rejects.toMatchObject({ code: "23505" });
  await expect(
    ctx.pool.query("INSERT INTO subkit.scheduler_sweep_cursors(producer) VALUES ('arbitrary')"),
  ).rejects.toMatchObject({ code: "22P02" });
});

test("cursor state is fixed platform metadata", () => {
  expect(PLATFORM_TABLES).toContain("scheduler_sweep_cursors");
});

test("invalid range, counter and lease shapes are rejected atomically", async () => {
  const invalid = [
    "epoch=-1",
    "revision=-1",
    "epoch=9007199254740992",
    "revision=9007199254740992",
    "after_id='00000000-0000-4000-8000-000000000001'",
    "epoch_upper_id='00000000-0000-4000-8000-000000000001'",
    "epoch_cutoff_at=clock_timestamp()",
    "epoch=0,epoch_upper_id='00000000-0000-4000-8000-000000000001',epoch_cutoff_at=clock_timestamp()",
    "epoch=1,after_id='00000000-0000-4000-8000-000000000002',epoch_upper_id='00000000-0000-4000-8000-000000000001',epoch_cutoff_at=clock_timestamp()",
    "lease_owner_boot_id='00000000-0000-4000-8000-000000000001'",
    "lease_token='00000000-0000-4000-8000-000000000001'",
    "lease_until=clock_timestamp()+interval '60 seconds'",
    "epoch=1,epoch_upper_id='00000000-0000-4000-8000-000000000001',epoch_cutoff_at=clock_timestamp(),lease_owner_boot_id='00000000-0000-4000-8000-000000000001',lease_token='00000000-0000-4000-8000-000000000002',lease_until=updated_at+interval '61 seconds'",
    "epoch=1,epoch_upper_id='00000000-0000-4000-8000-000000000001',epoch_cutoff_at=clock_timestamp(),lease_owner_boot_id='00000000-0000-4000-8000-000000000001',lease_token='00000000-0000-4000-8000-000000000002',lease_until=updated_at",
  ];
  const before = await ctx.db
    .select()
    .from(schedulerSweepCursors)
    .where(eq(schedulerSweepCursors.producer, "catalog"));
  for (const fields of invalid) {
    await expect(
      ctx.pool.query(
        `UPDATE subkit.scheduler_sweep_cursors SET ${fields} WHERE producer='catalog'`,
      ),
    ).rejects.toMatchObject({ code: "23514" });
  }
  expect(
    await ctx.db
      .select()
      .from(schedulerSweepCursors)
      .where(eq(schedulerSweepCursors.producer, "catalog")),
  ).toEqual(before);
});

test("active, released and idle states preserve millisecond positions", async () => {
  const updated =
    await ctx.pool.query(`WITH observed AS MATERIALIZED (SELECT date_trunc('milliseconds',clock_timestamp()) AS at)
    UPDATE subkit.scheduler_sweep_cursors SET epoch=1,revision=1,after_id=NULL,
    epoch_upper_id='00000000-0000-4000-8000-000000000002',epoch_cutoff_at=observed.at,
    lease_owner_boot_id='00000000-0000-4000-8000-000000000001',lease_token='00000000-0000-4000-8000-000000000003',
    updated_at=observed.at,lease_until=observed.at+interval '60 seconds' FROM observed WHERE producer='docs'
    RETURNING epoch_cutoff_at,updated_at,lease_until`);
  const row = updated.rows[0];
  expect(row.lease_until.getTime() - row.updated_at.getTime()).toBe(60_000);
  expect(row.epoch_cutoff_at).toEqual(row.updated_at);
  await ctx.pool.query(
    "UPDATE subkit.scheduler_sweep_cursors SET after_id=epoch_upper_id,revision=2,lease_owner_boot_id=NULL,lease_token=NULL,lease_until=NULL WHERE producer='docs'",
  );
  expect(
    (
      await ctx.db
        .select()
        .from(schedulerSweepCursors)
        .where(eq(schedulerSweepCursors.producer, "docs"))
    )[0],
  ).toMatchObject({ epoch: 1, revision: 2, lease_token: null });
  await ctx.pool.query(
    "UPDATE subkit.scheduler_sweep_cursors SET after_id=NULL,epoch_upper_id=NULL,epoch_cutoff_at=NULL,revision=3 WHERE producer='docs'",
  );
  expect(
    (
      await ctx.db
        .select()
        .from(schedulerSweepCursors)
        .where(eq(schedulerSweepCursors.producer, "docs"))
    )[0],
  ).toMatchObject({ epoch: 1, revision: 3, epoch_upper_id: null });
});
