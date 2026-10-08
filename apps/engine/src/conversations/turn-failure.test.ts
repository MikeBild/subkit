import { describe, expect, test } from "bun:test";
import { LlmProviderError, LlmQuotaExhausted } from "../llm/errors.ts";
import { toLlmProviderError } from "../llm/provider-errors.ts";
import {
  describeTurnFailure,
  LlmTimeoutError,
  timeoutPhaseOf,
  turnFailureFramePayload,
} from "./turn-failure.ts";

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

describe("timeouts", () => {
  test("the SDK's step timer is typed by its phase and keeps the budget it enforced", () => {
    const error = new DOMException("Step timeout of 5ms exceeded", "TimeoutError");
    expect(timeoutPhaseOf(error)).toBe("step");
    const failure = describeTurnFailure(error, now);
    expect(failure).toEqual({
      code: "llm_timeout",
      message: "Timed out after 1 s",
      at: "2026-09-29T15:00:00.000Z",
      timeout: { phase: "step", timeout_ms: 5 },
    });
    expect(turnFailureFramePayload(failure)).toEqual({
      code: "llm_timeout",
      message: "Timed out after 1 s",
      details: { phase: "step", timeout_ms: 5 },
    });
  });

  test("first-chunk and chunk timers are told apart by the SDK's label", () => {
    expect(
      timeoutPhaseOf(new DOMException("First chunk timeout of 120000ms exceeded", "TimeoutError")),
    ).toBe("first_chunk");
    expect(
      timeoutPhaseOf(new DOMException("Chunk timeout of 30000ms exceeded", "TimeoutError")),
    ).toBe("chunk");
  });

  test("AbortSignal.timeout's own reason is the total budget, whose size the reason does not carry", async () => {
    const signal = AbortSignal.timeout(1);
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    expect(timeoutPhaseOf(signal.reason)).toBe("total");
    const failure = describeTurnFailure(signal.reason, now);
    expect(failure.code).toBe("llm_timeout");
    expect(failure.message).toBe("Timed out");
    expect(failure.timeout).toEqual({ phase: "total", timeout_ms: null });
    expect(turnFailureFramePayload(failure).details).toEqual({ phase: "total" });
  });

  test("the loop's own timeout error names phase and budget in whole seconds", () => {
    const error = new LlmTimeoutError("total", 720_000);
    expect(error.name).toBe("TimeoutError");
    expect(error.message).toBe("Timed out after 720 s");
    expect(timeoutPhaseOf(error)).toBe("total");
    const failure = describeTurnFailure(error, now);
    expect(failure).toEqual({
      code: "llm_timeout",
      message: "Timed out after 720 s",
      at: "2026-09-29T15:00:00.000Z",
      timeout: { phase: "total", timeout_ms: 720_000 },
    });
    expect(turnFailureFramePayload(failure).details).toEqual({
      phase: "total",
      timeout_ms: 720_000,
    });
  });

  test("a sub-second budget rounds up, never to zero", () => {
    expect(new LlmTimeoutError("first_chunk", 200).message).toBe("Timed out after 1 s");
  });

  test("a cancellation is not a timeout", () => {
    const aborted = new DOMException("conversation_cancelled", "AbortError");
    expect(timeoutPhaseOf(aborted)).toBeNull();
    expect(describeTurnFailure(aborted, now).code).toBe("internal");
    expect(timeoutPhaseOf("conversation_cancelled")).toBeNull();
  });
});
