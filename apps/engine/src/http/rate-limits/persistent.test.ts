import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { httpRateLimitBuckets } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import {
  admitPersistentRateLimits,
  consumePersistentRateLimits,
  rateLimitBucketKey,
} from "./persistent.ts";

let fixture: TestDb;
const timestamp = new Date("2040-01-01T12:00:00.000Z");
const key = (name: string) => rateLimitBucketKey("fixture-hmac-key", "peer", name);
beforeAll(async () => {
  fixture = await createTestDb("http-persisted-rate");
});
afterAll(async () => {
  await fixture?.cleanup();
});

test("parallel callers share an atomic persisted ceiling", async () => {
  const bucket_key = key("parallel");
  const outcomes = await Promise.all(
    Array.from({ length: 20 }, () =>
      consumePersistentRateLimits([{ bucket_key, max: 5 }], fixture.db, timestamp),
    ),
  );
  expect(outcomes.filter(Boolean)).toHaveLength(5);
  const [bucket] = await fixture.db
    .select()
    .from(httpRateLimitBuckets)
    .where(eq(httpRateLimitBuckets.bucket_key, bucket_key));
  expect(bucket?.hits).toBe(5);
});

test("a new client wrapper cannot reset persisted capacity and the next window refills", async () => {
  const bucket_key = key("restart");
  expect(await consumePersistentRateLimits([{ bucket_key, max: 1 }], fixture.db, timestamp)).toBe(
    true,
  );
  expect(await consumePersistentRateLimits([{ bucket_key, max: 1 }], fixture.db, timestamp)).toBe(
    false,
  );
  expect(
    await consumePersistentRateLimits(
      [{ bucket_key, max: 1 }],
      fixture.db,
      new Date("2040-01-01T12:01:00.000Z"),
    ),
  ).toBe(true);
});

test("global exhaustion cannot be bypassed by changing peer keys", async () => {
  const globalKey = rateLimitBucketKey("fixture-hmac-key", "global", "ceiling");
  const outcomes = await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      consumePersistentRateLimits(
        [
          { bucket_key: globalKey, max: 3 },
          { bucket_key: key(`peer-${index}`), max: 5 },
        ],
        fixture.db,
        timestamp,
      ),
    ),
  );
  expect(outcomes.filter(Boolean)).toHaveLength(3);
});

test("scope separation is opaque and expired rows are removed on subsequent admission", async () => {
  const tenantKey = rateLimitBucketKey("fixture-hmac-key", "tenant", "private-identifier");
  expect(tenantKey).not.toContain("private-identifier");
  expect(tenantKey).not.toBe(rateLimitBucketKey("fixture-hmac-key", "peer", "private-identifier"));
  await consumePersistentRateLimits([{ bucket_key: tenantKey, max: 1 }], fixture.db, timestamp);
  await consumePersistentRateLimits(
    [{ bucket_key: key("later"), max: 1 }],
    fixture.db,
    new Date("2040-01-01T12:04:00.000Z"),
  );
  expect(
    await fixture.db
      .select()
      .from(httpRateLimitBuckets)
      .where(eq(httpRateLimitBuckets.bucket_key, tenantKey)),
  ).toHaveLength(0);
});

test("missing or malformed operator limits cannot admit a request", async () => {
  await expect(
    consumePersistentRateLimits([{ bucket_key: key("bad"), max: 0 }], fixture.db, timestamp),
  ).rejects.toThrow();
  expect(() => rateLimitBucketKey("", "peer", "unknown")).toThrow();
});

test("a rejected peer cannot consume the remaining global ceiling", async () => {
  const globalKey = rateLimitBucketKey("fixture-hmac-key", "global", "peer-denials");
  const peerKey = key("blocked-peer");
  const take = (peer: string) =>
    consumePersistentRateLimits(
      [
        { bucket_key: globalKey, max: 3 },
        { bucket_key: peer, max: 1 },
      ],
      fixture.db,
      new Date("2040-02-01T12:00:00.000Z"),
    );
  expect(await take(peerKey)).toBe(true);
  for (let attempt = 0; attempt < 5; attempt++) expect(await take(peerKey)).toBe(false);
  expect(await take(key("other-peer"))).toBe(true);
  expect(await take(key("third-peer"))).toBe(true);
  expect(await take(key("fourth-peer"))).toBe(false);
});

test("the accepted monthly allowance admits exactly the ten-thousandth request under concurrency", async () => {
  const bucket_key = rateLimitBucketKey("fixture-hmac-key", "tenant_month", "free-monthly");
  await fixture.db.insert(httpRateLimitBuckets).values({
    bucket_key,
    window_started_at: new Date("2040-04-01T00:00:00.000Z"),
    expires_at: new Date("2040-05-01T00:03:00.000Z"),
    hits: 9999,
  });
  const results = await Promise.all(
    Array.from({ length: 4 }, () =>
      admitPersistentRateLimits(
        [{ bucket_key, max: 10000, window: "month" }],
        fixture.db,
        new Date("2040-04-02T12:00:00.000Z"),
      ),
    ),
  );
  expect(results.filter((result) => result.allowed)).toHaveLength(1);
  expect(
    results
      .filter((result) => !result.allowed)
      .every(
        (result) => !result.allowed && result.window === "month" && result.retry_after_seconds > 60,
      ),
  ).toBe(true);
});

test("monthly counters use UTC calendar boundaries and survive intervening minute windows", async () => {
  const bucket_key = rateLimitBucketKey("fixture-hmac-key", "tenant_month", "month-rollover");
  const input = [{ bucket_key, max: 1, window: "month" as const }];
  expect(
    await consumePersistentRateLimits(input, fixture.db, new Date("2040-01-01T00:00:00.000Z")),
  ).toBe(true);
  expect(
    await consumePersistentRateLimits(input, fixture.db, new Date("2040-01-31T23:59:59.999Z")),
  ).toBe(false);
  expect(
    await consumePersistentRateLimits(input, fixture.db, new Date("2040-02-01T00:00:00.000Z")),
  ).toBe(true);
});
