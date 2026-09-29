import { describe, expect, test } from "bun:test";
import { LlmProviderError, LlmQuotaExhausted } from "../llm/errors.ts";
import { toLlmProviderError } from "../llm/provider-errors.ts";
import { describeTurnFailure, turnFailureFramePayload } from "./turn-failure.ts";

const now = new Date("2026-09-29T15:00:00.000Z");
const QUOTA_SENTENCE =
  "You have reached your specified API usage limits. You will regain access on 2026-10-01 at 00:00 UTC.";

describe("describeTurnFailure", () => {
  test("a provider quota is typed and carries the time access returns", () => {
    const failure = describeTurnFailure(toLlmProviderError(new Error(QUOTA_SENTENCE)), now);
    expect(failure).toEqual({
      code: "llm_provider_limited",
      message: QUOTA_SENTENCE,
      at: "2026-09-29T15:00:00.000Z",
      kind: "quota_exhausted",
      retry_at: "2026-10-01T00:00:00.000Z",
    });
    expect(turnFailureFramePayload(failure)).toEqual({
      code: "llm_provider_limited",
      message: QUOTA_SENTENCE,
      details: { kind: "quota_exhausted", retry_at: "2026-10-01T00:00:00.000Z" },
    });
  });

  test("uses the error envelope's codes for the other provider failures", () => {
    const code = (error: LlmProviderError) => describeTurnFailure(error, now).code;
    expect(code(new LlmProviderError("rate_limit", "429"))).toBe("llm_provider_limited");
    expect(code(new LlmProviderError("overloaded", "Overloaded"))).toBe("llm_provider_unavailable");
    expect(code(new LlmProviderError("other", "connect ECONNREFUSED"))).toBe(
      "llm_provider_unavailable",
    );
    expect(code(new LlmProviderError("context_length_exceeded", "too long"))).toBe(
      "llm_context_too_large",
    );
  });

  test("the installation's own budget is not the provider's", () => {
    expect(describeTurnFailure(new LlmQuotaExhausted(), now).code).toBe("llm_quota_exhausted");
  });

  test("anything else stays internal, with no invented cause", () => {
    const failure = describeTurnFailure(new Error("boom"), now);
    expect(failure).toEqual({ code: "internal", message: "boom", at: "2026-09-29T15:00:00.000Z" });
    expect(turnFailureFramePayload(failure)).toEqual({ code: "internal", message: "boom" });
  });
});
