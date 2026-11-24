import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { llmUsage } from "../db/schema/llm.ts";
import { usageEvents } from "../db/schema/usage.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { type EnvHandle, testEnv, withTestEnv } from "../test-helpers/determinism/env.ts";
import { seedTenant } from "../test-helpers/seed.ts";
import { aggregateLlm } from "./aggregate-llm.ts";
import { aggregateUsage } from "./aggregate-usage.ts";
import { type BucketSeriesWindow, readBucketSeries } from "./bucket-fill.ts";
import type { BucketUnit } from "./bucket-units.ts";

const skip = testEnv.REQUIRES_PG === "0";

const ENGINE_TZ = "Europe/Berlin";
const NOON_CALL = new Date("2026-11-23T12:11:00.000Z");
const MIDNIGHT_CALL = new Date("2026-11-16T00:00:00.000Z");
const FROM = new Date("2026-11-10T00:00:00.000Z");
const TO = new Date("2026-11-24T00:00:00.000Z");

let testDb: TestDb;
let tenantId: string;
let engineTz: EnvHandle | undefined;

beforeAll(async () => {
  if (skip) return;
  engineTz = withTestEnv({ TZ: ENGINE_TZ });
  testDb = await createTestDb("stats-bucket-tz");
  tenantId = (
    await seedTenant(testDb.db, { slug: "stats-bucket-tz", display_name: "Stats Bucket TZ" })
  ).id;
  await testDb.db.insert(llmUsage).values(
    [NOON_CALL, MIDNIGHT_CALL].map((created_at) => ({
      tenant_id: tenantId,
      flow: "converse",
      model: "claude-haiku-4-5",
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 2,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      latency_ms: 10,
      result: "success",
      created_at,
      month_bucket: created_at.getUTCFullYear() * 100 + created_at.getUTCMonth() + 1,
    })),
  );
  await testDb.db.insert(usageEvents).values(
    [NOON_CALL, MIDNIGHT_CALL].map((created_at) => ({
      tenant_id: tenantId,
      surface: "http",
      operation: "GET /v1/workflows",
      outcome: "success",
      request_source: "cli",
      created_at,
    })),
  );
}, 60_000);

afterAll(async () => {
  engineTz?.restore();
  if (!skip && testDb?.cleanup) await testDb.cleanup();
}, 30_000);

const llmBucketTs = async (bucket: BucketUnit, tz: string) =>
  (
    await aggregateLlm(testDb.db, { tenantId, bucket, from: FROM, to: TO, tz, groupBy: [] })
  ).groups[0]!.buckets.map((b) => b.ts);

const usageBucketTs = async (bucket: BucketUnit, tz: string) =>
  (
    await aggregateUsage(testDb.db, {
      tenantId,
      surface: "http",
      bucket,
      from: FROM,
      to: TO,
      tz,
      trafficClass: ["organic"],
      groupBy: [],
    })
  ).groups[0]!.buckets.map((b) => b.ts);

const seriesKeys = (bucket: BucketUnit, tz: string) =>
  readBucketSeries(testDb.db, { bucket, from: FROM, to: TO, tz } satisfies BucketSeriesWindow);

describe.skipIf(skip)("bucket ts on a non-UTC engine (#514)", () => {
  test("tz=UTC hour buckets keep the UTC hour", async () => {
    const expected = ["2026-11-16T00:00:00.000Z", "2026-11-23T12:00:00.000Z"];
    expect(await llmBucketTs("hour", "UTC")).toEqual(expected);
    expect(await usageBucketTs("hour", "UTC")).toEqual(expected);
    const keys = await seriesKeys("hour", "UTC");
    for (const ts of expected) expect(keys).toContain(ts);
    expect(keys[0]).toBe("2026-11-10T00:00:00.000Z");
  });

  test("tz=UTC day buckets keep the UTC day", async () => {
    const expected = ["2026-11-16T00:00:00.000Z", "2026-11-23T00:00:00.000Z"];
    expect(await llmBucketTs("day", "UTC")).toEqual(expected);
    expect(await usageBucketTs("day", "UTC")).toEqual(expected);
    const keys = await seriesKeys("day", "UTC");
    for (const ts of expected) expect(keys).toContain(ts);
  });

  test("tz=Europe/Berlin buckets carry the Berlin wall clock", async () => {
    const expected = ["2026-11-16T01:00:00.000Z", "2026-11-23T13:00:00.000Z"];
    expect(await llmBucketTs("hour", "Europe/Berlin")).toEqual(expected);
    expect(await usageBucketTs("hour", "Europe/Berlin")).toEqual(expected);
    const keys = await seriesKeys("hour", "Europe/Berlin");
    for (const ts of expected) expect(keys).toContain(ts);
    expect(keys[0]).toBe("2026-11-10T01:00:00.000Z");
  });
});
