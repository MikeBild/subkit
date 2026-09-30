import { describe, expect, it } from "bun:test";
import { LlmProviderError } from "./errors.ts";
import {
  buildProviderErrorDetails,
  classifyProviderError,
  isFallbackEligible,
  shouldFallBack,
} from "./provider-errors.ts";

describe("provider-errors", () => {
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
