import { describe, expect, it } from "bun:test";
import {
  buildProviderErrorDetails,
  classifyProviderError,
  isFallbackEligible,
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
});
