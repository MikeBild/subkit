import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { admitPersistentRateLimits, rateLimitBucketKey } from "../db/rate-limits.ts";
import { httpRateLimitBuckets } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { minuteBucketStart, pinAdmissionClock } from "./pinned-admission-clock.ts";

let fixture: TestDb;
beforeAll(async () => {
  fixture = await createTestDb("pinned-admission-clock");
});
afterAll(async () => {
  await fixture?.cleanup();
});

test("pins omitted timestamps, preserves explicit callers, and restores the real delegate", async () => {
  const pinned = new Date("2040-04-02T12:34:56.000Z");
  const explicit = new Date("2041-05-03T01:02:03.000Z");
  const clock = pinAdmissionClock(pinned);
  const pinnedKey = rateLimitBucketKey("pinned-admission-clock", "peer", "pinned");
  const explicitKey = rateLimitBucketKey("pinned-admission-clock", "peer", "explicit");
  try {
    expect(
      await admitPersistentRateLimits([{ bucket_key: pinnedKey, max: 1 }], fixture.db),
    ).toEqual({
      allowed: true,
    });
    expect(
      await admitPersistentRateLimits([{ bucket_key: explicitKey, max: 1 }], fixture.db, explicit),
    ).toEqual({ allowed: true });
    expect(clock.calls).toHaveLength(2);
    expect(clock.calls[0]?.timestamp).toEqual(pinned);
    expect(clock.calls[1]?.timestamp).toEqual(explicit);
    expect(clock.calls.every(({ executor }) => executor === fixture.db)).toBe(true);
  } finally {
    clock.restore();
    clock.restore();
  }

  const restoredKey = rateLimitBucketKey("pinned-admission-clock", "peer", "restored");
  expect(
    await admitPersistentRateLimits([{ bucket_key: restoredKey, max: 1 }], fixture.db),
  ).toEqual({
    allowed: true,
  });
  expect(clock.calls).toHaveLength(2);
  const [restored] = await fixture.db
    .select()
    .from(httpRateLimitBuckets)
    .where(eq(httpRateLimitBuckets.bucket_key, restoredKey));
  expect(restored?.window_started_at.getTime()).not.toBe(minuteBucketStart(pinned).getTime());
});
