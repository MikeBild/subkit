import { afterAll, beforeAll, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { PROBE_PATH_V1_BACKFILL_NAME } from "../connectors/backfills/probe-path-v1.ts";
import { dataMigrations } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { LOOP_TO_FOR_EACH_V2_BACKFILL_NAME } from "../workflows/backfills/loop-to-for-each-v2.ts";
import { MODEL_STEP_V1_BACKFILL_NAME } from "../workflows/backfills/model-step-v1.ts";
import { REQUEST_PROTOCOL_V1_BACKFILL_NAME } from "../workflows/backfills/request-protocol-v1.ts";
import { runDataBackfillsFromUrl } from "./data-backfills.ts";

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb("data_backfills_boot");
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

test("the boot step runs every data backfill once and records its marker", async () => {
  const names = [
    LOOP_TO_FOR_EACH_V2_BACKFILL_NAME,
    REQUEST_PROTOCOL_V1_BACKFILL_NAME,
    MODEL_STEP_V1_BACKFILL_NAME,
    PROBE_PATH_V1_BACKFILL_NAME,
  ];
  const markers = () =>
    ctx.db
      .select({ name: dataMigrations.name })
      .from(dataMigrations)
      .where(inArray(dataMigrations.name, names));
  expect(await markers()).toEqual([]);
  await runDataBackfillsFromUrl(ctx.url);
  expect((await markers()).map((row) => row.name).sort()).toEqual([...names].sort());
  await runDataBackfillsFromUrl(ctx.url);
  expect(await markers()).toHaveLength(names.length);
});
