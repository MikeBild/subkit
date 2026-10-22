import { describe, expect, test } from "bun:test";
import { classifyConnectorHealth } from "../../../connectors/health.ts";
import { rateLimitDelayMs } from "./rate-limit.ts";

const NOW = 1_800_000_000_000;
const base = { attempt: 1, now_ms: NOW, backoff_base_ms: 200, deadline_ms: NOW + 120_000 };

describe("rateLimitDelayMs", () => {
  test("ordinary responses are not rate limits", () => {
    expect(rateLimitDelayMs({ ...base, status: 200, headers: {}, body: {} })).toEqual({
      kind: "none",
    });
    expect(
      rateLimitDelayMs({
        ...base,
        status: 200,
        headers: { "x-ratelimit-remaining": "0" },
        body: [],
      }),
    ).toEqual({ kind: "none" });
    expect(
      rateLimitDelayMs({ ...base, status: 403, headers: {}, body: { message: "Forbidden" } }),
    ).toEqual({ kind: "none" });
    expect(rateLimitDelayMs({ ...base, status: 404, headers: {}, body: null })).toEqual({
      kind: "none",
    });
  });

  test("retry-after wins on 403 and 429", () => {
    for (const status of [403, 429]) {
      expect(
        rateLimitDelayMs({ ...base, status, headers: { "retry-after": "3" }, body: null }),
      ).toEqual({ kind: "wait", delay_ms: 3000, reason: "retry_after" });
    }
  });

  test("an exhausted primary limit waits until reset plus one second", () => {
    expect(
      rateLimitDelayMs({
        ...base,
        status: 403,
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(Math.floor(NOW / 1000) + 2),
        },
        body: { message: "API rate limit exceeded for user ID 1." },
      }),
    ).toEqual({ kind: "wait", delay_ms: 3000, reason: "primary_reset" });
  });

  test("a secondary limit without headers waits at least one minute", () => {
    expect(
      rateLimitDelayMs({
        ...base,
        status: 403,
        headers: {},
        body: { message: "You have exceeded a secondary rate limit. Please wait a few minutes." },
      }),
    ).toEqual({ kind: "wait", delay_ms: 60_000, reason: "secondary_backoff" });
    expect(
      rateLimitDelayMs({
        ...base,
        attempt: 2,
        deadline_ms: NOW + 10 * 60_000,
        status: 429,
        headers: {},
        body: { message: "secondary rate limit" },
      }),
    ).toEqual({ kind: "wait", delay_ms: 120_000, reason: "secondary_backoff" });
    expect(
      rateLimitDelayMs({
        ...base,
        attempt: 2,
        status: 403,
        headers: {},
        body: { message: "You have exceeded a secondary rate limit." },
      }),
    ).toEqual({ kind: "fail", delay_ms: 120_000, reason: "secondary_backoff" });
  });

  test("a plain 429 without hints keeps the ordinary backoff", () => {
    const verdict = rateLimitDelayMs({ ...base, status: 429, headers: {}, body: null });
    expect(verdict.kind).toBe("wait");
    if (verdict.kind === "wait") {
      expect(verdict.reason).toBe("backoff");
      expect(verdict.delay_ms).toBeLessThan(60_000);
    }
  });

  test("GraphQL RATE_LIMITED errors on 200 are rate limits", () => {
    expect(
      rateLimitDelayMs({
        ...base,
        status: 200,
        headers: { "retry-after": "1" },
        body: { errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] },
      }),
    ).toEqual({ kind: "wait", delay_ms: 1000, reason: "retry_after" });
  });

  test("a wait past the deadline or one hour fails", () => {
    expect(
      rateLimitDelayMs({
        ...base,
        status: 403,
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(Math.floor(NOW / 1000) + 3600),
        },
        body: null,
      }),
    ).toEqual({ kind: "fail", delay_ms: 3_601_000, reason: "primary_reset" });
    expect(
      rateLimitDelayMs({
        ...base,
        deadline_ms: NOW + 10 * 60 * 60_000,
        status: 429,
        headers: { "retry-after": "7200" },
        body: null,
      }),
    ).toEqual({ kind: "fail", delay_ms: 7_200_000, reason: "retry_after" });
  });
});

describe("connector health for rate limits", () => {
  test("a rate-limited 403 is rate_limited, never auth_failed", () => {
    expect(classifyConnectorHealth(403, { "x-ratelimit-remaining": "0" })).toBe("rate_limited");
    expect(classifyConnectorHealth(403, { "retry-after": "60" })).toBe("rate_limited");
    expect(classifyConnectorHealth(403, {})).toBe("auth_failed");
    expect(classifyConnectorHealth(429, {})).toBe("rate_limited");
  });
});
