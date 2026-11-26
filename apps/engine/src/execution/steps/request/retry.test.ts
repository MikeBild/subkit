import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { rateLimitDelayMs } from "./rate-limit.ts";
import { backoffMs, RETRY_BASE_MS, RETRY_CAP_MS, requestMaxAttempts } from "./retry.ts";

const NOW = 1_000_000;

function withRandom(value: number): void {
  spyOn(Math, "random").mockReturnValue(value);
}

afterEach(() => {
  (Math.random as unknown as { mockRestore?: () => void }).mockRestore?.();
});

describe("request retry schedule", () => {
  test("doubles from the base and keeps the exact midpoint without jitter", () => {
    withRandom(0.5);
    expect([0, 1, 2, 3, 4, 5].map((attempt) => backoffMs(attempt))).toEqual([
      200, 400, 800, 1_600, 3_200, 6_400,
    ]);
  });

  test("stays within plus or minus 20 percent and is not rounded", () => {
    withRandom(0);
    expect(backoffMs(0)).toBe(160);
    expect(backoffMs(2, 333)).toBeCloseTo(1_065.6, 6);
    withRandom(1);
    expect(backoffMs(0)).toBe(240);
    expect(backoffMs(2, 333)).toBeCloseTo(1_598.4, 6);
  });

  test("caps at 30 seconds before the jitter is applied", () => {
    withRandom(1);
    expect(backoffMs(20)).toBe(RETRY_CAP_MS * 1.2);
    withRandom(0);
    expect(backoffMs(20, RETRY_BASE_MS)).toBe(RETRY_CAP_MS * 0.8);
  });
});

describe("rate limit secondary backoff schedule", () => {
  test("starts at one minute and doubles from the second attempt", () => {
    const delays = [0, 1, 2, 3, 4].map((attempt) => {
      const verdict = rateLimitDelayMs({
        status: 403,
        headers: {},
        body: { message: "secondary rate limit" },
        attempt,
        now_ms: NOW,
        backoff_base_ms: RETRY_BASE_MS,
        deadline_ms: NOW + 10 * 60 * 60_000,
      });
      return verdict.kind === "none" ? null : verdict.delay_ms;
    });
    expect(delays).toEqual([60_000, 60_000, 120_000, 240_000, 480_000]);
  });

  test("a plain 429 uses the request schedule", () => {
    withRandom(0.5);
    const verdict = rateLimitDelayMs({
      status: 429,
      headers: {},
      body: null,
      attempt: 3,
      now_ms: NOW,
      backoff_base_ms: 100,
      deadline_ms: NOW + 60_000,
    });
    expect(verdict).toEqual({ kind: "wait", delay_ms: 800, reason: "backoff" });
  });
});

describe("request attempts", () => {
  const owned = {
    variables: { "scope.make.data.id": { created_by_workflow: true as const } },
    max_body_bytes: 0,
    max_calls: 1,
    destructive: true as const,
  };
  const listed = { ...owned, variables: { "input.id": { enum: ["a"] } } };
  test.each([
    ["the default", {}, 5],
    ["explicit retries", { max_retries: 2 }, 3],
    ["no retries", { max_retries: 0 }, 1],
    ["a listed removal with retries", { max_retries: 2, boundary: listed }, 3],
    ["an owned removal with default retries", { boundary: owned }, 1],
    ["an owned removal with retries", { max_retries: 5, boundary: owned }, 1],
  ])("%s allows %s attempt(s)", (_name, step, attempts) => {
    expect(requestMaxAttempts(step)).toBe(attempts);
  });
});
