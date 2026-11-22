import { describe, expect, it } from "bun:test";
import { APICallError, RetryError } from "ai";
import { LlmProviderError } from "./errors.ts";
import {
  buildProviderErrorDetails,
  classifyProviderError,
  isFallbackEligible,
  shouldFallBack,
  toLlmProviderError,
} from "./provider-errors.ts";

function providerCallError(statusCode: number, message: string): APICallError {
  return new APICallError({
    message,
    url: "https://provider.example.com/v1/messages",
    requestBodyValues: {},
    statusCode,
    isRetryable: false,
  });
}

describe("provider-errors", () => {
  it("a 401 or 403 during a run means the key was rejected, whatever the text says", () => {
    for (const status of [401, 403]) {
      for (const message of [
        "invalid x-api-key",
        "insufficient_quota: check your plan and billing details",
        "rate limit reached for requests",
        "Service temporarily unavailable",
      ]) {
        const err = providerCallError(status, message);
        expect(classifyProviderError(err)).toBe("key_rejected");
        expect(isFallbackEligible(err)).toBe(false);
        expect(toLlmProviderError(err).kind).toBe("key_rejected");
      }
    }
  });

  it("a rejected key wrapped by the SDK retry is still recognized by its status", () => {
    const err = new RetryError({
      message: "Failed after 3 attempts",
      reason: "maxRetriesExceeded",
      errors: [providerCallError(401, "Unauthorized")],
    });
    expect(classifyProviderError(err)).toBe("key_rejected");
  });

  it("a key-like word without a 401 or 403 is not a rejected key", () => {
    expect(classifyProviderError({ message: "invalid api key" })).toBe("other");
    expect(classifyProviderError(providerCallError(400, "Unauthorized model"))).toBe("other");
  });

  it("classifies provider usage-limit wording as quota_exhausted", () => {
    expect(
      classifyProviderError({
        message: "You have reached your specified API usage limits. Try again later.",
      }),
    ).toBe("quota_exhausted");
    expect(isFallbackEligible({ message: "specified API usage limits" })).toBe(true);
  });

  it("extracts retry_at from regain-access wording", () => {
    const details = buildProviderErrorDetails({
      statusCode: 429,
      message:
        "You have reached your specified API usage limits. You will regain access on 2026-05-01 at 00:00 UTC.",
    });
    expect(details).toEqual({
      upstream_status: 429,
      retry_at: "2026-05-01T00:00:00.000Z",
    });
  });

  it("moves a usage limit to the fallback only across providers", () => {
    const quota = { statusCode: 400, message: "You have reached your specified API usage limits." };
    expect(shouldFallBack(quota, "anthropic", "openai")).toBe(true);
    expect(shouldFallBack(quota, "anthropic", "anthropic")).toBe(false);
  });

  it("keeps a transient refusal on the fallback even on the same provider", () => {
    expect(
      shouldFallBack({ statusCode: 529, message: "Overloaded" }, "anthropic", "anthropic"),
    ).toBe(true);
  });

  it("never retries a genuine request error", () => {
    const bad = { statusCode: 400, message: "messages.0.content: field required" };
    expect(shouldFallBack(bad, "anthropic", "openai")).toBe(false);
  });

  it("reads the kind a typed provider error already carries", () => {
    const typed = new LlmProviderError("context_length_exceeded", "mock: context too large");
    expect(classifyProviderError(typed)).toBe("context_length_exceeded");
    expect(shouldFallBack(typed, "mock", "mock")).toBe(true);
  });
});
