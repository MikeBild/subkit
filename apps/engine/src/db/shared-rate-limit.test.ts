import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDesktopLoginRateLimiter } from "../auth/index.ts";
import type { Executor } from "./client.ts";
import { admitPersistentRateLimits, rateLimitBucketKey } from "./rate-limits.ts";
import { createSharedRateLimiter, type WindowLimit } from "./shared-rate-limit.ts";
import { createTestDb, type TestDb } from "./tests/setup.ts";

let fixture: TestDb;
const SECRET = "shared-limit-fixture-secret-0123456789";

beforeAll(async () => {
  fixture = await createTestDb("shared-rate-limit");
}, 60_000);

afterAll(async () => {
  await fixture?.cleanup();
}, 30_000);

function engineProcess(
  scope: "desktop_login" | "feedback",
  name: string,
  limits: WindowLimit,
  secret: () => string = () => SECRET,
) {
  return createSharedRateLimiter({
    scope,
    name,
    limits,
    local: createDesktopLoginRateLimiter(limits),
    secret,
  });
}

describe("a limit shared by every engine process", () => {
  test("three processes together admit the limit once, not once each", async () => {
    const limits = { max: 10, windowMs: 60_000 };
    const processes = [
      engineProcess("desktop_login", "session", limits),
      engineProcess("desktop_login", "session", limits),
      engineProcess("desktop_login", "session", limits),
    ];
    const verdicts = await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        (processes[index % 3] ?? processes[0])?.take(fixture.db, "203.0.113.7"),
      ),
    );
    expect(verdicts.filter((verdict) => verdict?.allowed)).toHaveLength(10);
    const refused = verdicts.find((verdict) => verdict && !verdict.allowed);
    expect(refused?.retry_after_seconds).toBeGreaterThanOrEqual(1);
    expect(refused?.retry_after_seconds).toBeLessThanOrEqual(60);
    const other = await processes[0]?.take(fixture.db, "203.0.113.8");
    expect(other).toEqual({ allowed: true, retry_after_seconds: 0 });
  });

  test("steps of one flow and different limits count on their own", async () => {
    const limits = { max: 1, windowMs: 60_000 };
    const start = engineProcess("desktop_login", "start", limits);
    const confirm = engineProcess("desktop_login", "confirm", limits);
    const wider = engineProcess("desktop_login", "start", { max: 2, windowMs: 60_000 });
    expect((await start.take(fixture.db, "198.51.100.1")).allowed).toBe(true);
    expect((await start.take(fixture.db, "198.51.100.1")).allowed).toBe(false);
    expect((await confirm.take(fixture.db, "198.51.100.1")).allowed).toBe(true);
    expect((await wider.take(fixture.db, "198.51.100.1")).allowed).toBe(true);
  });

  test("the feedback limit holds for ten minutes across processes", async () => {
    const limits = { max: 5, windowMs: 10 * 60_000 };
    const one = engineProcess("feedback", "submit", limits);
    const two = engineProcess("feedback", "submit", limits);
    const verdicts = [];
    for (let index = 0; index < 7; index++)
      verdicts.push(await (index % 2 === 0 ? one : two).take(fixture.db, "tenant:person"));
    expect(verdicts.map((verdict) => verdict.allowed)).toEqual([
      true,
      true,
      true,
      true,
      true,
      false,
      false,
    ]);
    expect(verdicts[6]?.retry_after_seconds).toBeLessThanOrEqual(600);
  });

  test("the ten-minute window starts on the clock and refills in the next one", async () => {
    const bucket_key = rateLimitBucketKey(SECRET, "feedback", "window-edges");
    const take = (at: string) =>
      admitPersistentRateLimits(
        [{ bucket_key, max: 1, window: "ten_minutes" }],
        fixture.db,
        new Date(at),
      );
    expect(await take("2040-01-01T12:03:00.000Z")).toEqual({ allowed: true });
    expect(await take("2040-01-01T12:09:30.000Z")).toEqual({
      allowed: false,
      window: "ten_minutes",
      retry_after_seconds: 30,
    });
    expect(await take("2040-01-01T12:10:00.000Z")).toEqual({ allowed: true });
  });
});

describe("when the shared store cannot be used", () => {
  const limits = { max: 2, windowMs: 60_000 };

  test("without a signing secret the limit counts in this process", async () => {
    const limiter = engineProcess("feedback", "no-secret", limits, () => "");
    const verdicts = [];
    for (let index = 0; index < 3; index++)
      verdicts.push((await limiter.take(fixture.db, "person")).allowed);
    expect(verdicts).toEqual([true, true, false]);
    const fresh = engineProcess("feedback", "no-secret", limits, () => "");
    expect((await fresh.take(fixture.db, "person")).allowed).toBe(true);
  });

  test("a window the store does not know and a failing database fall back the same way", async () => {
    const odd = engineProcess("feedback", "odd-window", { max: 1, windowMs: 90_000 });
    expect((await odd.take(fixture.db, "person")).allowed).toBe(true);
    expect((await odd.take(fixture.db, "person")).allowed).toBe(false);
    const broken = {
      transaction: async () => {
        throw new Error("connection refused");
      },
    } as unknown as Executor;
    const limiter = engineProcess("desktop_login", "db-down", { max: 1, windowMs: 60_000 });
    expect((await limiter.take(broken, "203.0.113.9")).allowed).toBe(true);
    expect((await limiter.take(broken, "203.0.113.9")).allowed).toBe(false);
  });
});
