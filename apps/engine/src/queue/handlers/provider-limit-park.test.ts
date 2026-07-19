// planProviderLimitPark — pure unit coverage.
//
// The plan decides whether a failed `conversation.run-turn` job is parked
// (re-enqueued with `startAfter`) instead of terminally failed. Quota /
// rate-limit provider errors park; semantic failures never do; parks are
// bounded; a provider-stated reset time wins over the default backoff but
// is capped at the horizon.

import { describe, expect, test } from "bun:test";
import { LlmProviderError } from "../../llm/errors.ts";
import {
  PROVIDER_LIMIT_PARK_MAX,
  PROVIDER_LIMIT_PARK_MAX_HORIZON_MS,
  planProviderLimitPark,
  QUOTA_PARK_BASE_DELAY_MS,
  RATE_LIMIT_PARK_BASE_DELAY_MS,
} from "./provider-limit-park.ts";

const NOW = Date.parse("2026-07-19T12:00:00.000Z");

describe("planProviderLimitPark", () => {
  test("a quota error carrying a reset time parks exactly until the provider's reset", () => {
    const err = new LlmProviderError(
      "quota_exhausted",
      "You have reached your specified API usage limits. You will regain access on 2026-08-01 at 00:00 UTC.",
    );
    const plan = planProviderLimitPark(err, 0, NOW);
    expect(plan).not.toBeNull();
    expect(plan?.kind).toBe("quota_exhausted");
    expect(plan?.source).toBe("provider_reset");
    expect(plan?.start_after.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(plan?.parks).toBe(1);
  });

  test("a quota error whose reset time is in the past falls back to the default backoff", () => {
    const err = new LlmProviderError(
      "quota_exhausted",
      "you have reached your specified api usage limits. You will regain access on 2026-05-01 at 00:00 UTC.",
    );
    const plan = planProviderLimitPark(err, 0, NOW);
    expect(plan).not.toBeNull();
    expect(plan?.source).toBe("default_backoff");
    expect(plan?.start_after.getTime()).toBe(NOW + QUOTA_PARK_BASE_DELAY_MS);
  });

  test("a 429 rate limit without a reset time parks on the short backoff, doubling per park", () => {
    const err = Object.assign(new Error("rate limit exceeded"), { statusCode: 429 });
    const first = planProviderLimitPark(err, 0, NOW);
    expect(first?.kind).toBe("rate_limit");
    expect(first?.start_after.getTime()).toBe(NOW + RATE_LIMIT_PARK_BASE_DELAY_MS);
    const second = planProviderLimitPark(err, 1, NOW);
    expect(second?.start_after.getTime()).toBe(NOW + RATE_LIMIT_PARK_BASE_DELAY_MS * 2);
    expect(second?.parks).toBe(2);
  });

  test("a far-future reset time is capped at the park horizon", () => {
    const err = new LlmProviderError(
      "quota_exhausted",
      "usage limit reached. You will regain access on 2099-01-01 at 00:00 UTC.",
    );
    const plan = planProviderLimitPark(err, 0, NOW);
    expect(plan?.source).toBe("provider_reset");
    expect(plan?.start_after.getTime()).toBe(NOW + PROVIDER_LIMIT_PARK_MAX_HORIZON_MS);
  });

  test("semantic failures and other provider kinds never park", () => {
    expect(planProviderLimitPark(new Error("elicitation row missing"), 0, NOW)).toBeNull();
    expect(
      planProviderLimitPark(new LlmProviderError("overloaded", "overloaded"), 0, NOW),
    ).toBeNull();
    expect(
      planProviderLimitPark(
        new LlmProviderError("context_length_exceeded", "context_length"), // classifier: context bucket
        0,
        NOW,
      ),
    ).toBeNull();
  });

  test("the park budget is bounded: at PROVIDER_LIMIT_PARK_MAX prior parks the plan is null", () => {
    const err = new LlmProviderError("rate_limit", "rate limit");
    expect(planProviderLimitPark(err, PROVIDER_LIMIT_PARK_MAX - 1, NOW)).not.toBeNull();
    expect(planProviderLimitPark(err, PROVIDER_LIMIT_PARK_MAX, NOW)).toBeNull();
  });
});
