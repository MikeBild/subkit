import { describe, expect, test } from "bun:test";
import { graphqlRateLimitWaitMs } from "./graphql-retry.ts";

const now_ms = 1_800_000_000_000;
const wait = (status: number, headers: Record<string, string>, body: unknown = {}) =>
  graphqlRateLimitWaitMs({ status, headers, body, attempt: 0, backoff_base_ms: 200, now_ms });

describe("graphqlRateLimitWaitMs", () => {
  test("retry-after wins", () => {
    expect(wait(403, { "retry-after": "7", "x-ratelimit-remaining": "0" })).toBe(7000);
  });

  test("an exhausted primary budget waits until one second after the reset", () => {
    expect(
      wait(200, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(now_ms / 1000 + 30) }),
    ).toBe(31_000);
  });

  test("a secondary limit without headers waits at least one minute", () => {
    expect(wait(403, {})).toBe(60_000);
    expect(
      wait(200, {}, { errors: [{ message: "You have exceeded a secondary rate limit" }] }),
    ).toBe(60_000);
  });

  test("structured throttling without headers keeps the short backoff", () => {
    const backoff = wait(200, {}, { errors: [{ extensions: { code: "THROTTLED" } }] });
    expect(backoff).toBeGreaterThanOrEqual(0);
    expect(backoff).toBeLessThan(1000);
    expect(wait(429, {})).toBeLessThan(1000);
  });
});
