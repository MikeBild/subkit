import { describe, expect, test } from "bun:test";
import { APICallError } from "ai";
import { DrizzleQueryError } from "drizzle-orm";
import { HostedResourceCountError, HostedStorageQuotaError } from "../db/hosted-quota-errors.ts";
import { LlmAccessMissing, LlmProviderError, LlmSpendLimitReached } from "../llm/errors.ts";
import { toLlmProviderError } from "../llm/provider-errors.ts";
import {
  describeTurnFailure,
  LlmTimeoutError,
  providerFailureNotice,
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
      code: "llm_provider_quota_exhausted",
      message: QUOTA_SENTENCE,
      at: "2026-09-29T15:00:00.000Z",
      kind: "quota_exhausted",
      retry_at: "2026-10-01T00:00:00.000Z",
    });
    expect(turnFailureFramePayload(failure)).toEqual({
      code: "llm_provider_quota_exhausted",
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
    expect(describeTurnFailure(new LlmSpendLimitReached(), now).code).toBe(
      "llm_spend_limit_reached",
    );
  });

  test("workspace content quotas retain their safe typed contract through wrapped SQL errors", () => {
    const canary = "turn-quota-private-parameter-canary";
    for (const quota of [new HostedStorageQuotaError(), new HostedResourceCountError()]) {
      const failure = describeTurnFailure(
        new Error(`query parameters: ${canary}`, { cause: quota }),
        now,
      );
      expect(failure.code).toBe(quota.code);
      expect(failure.message).toBe(quota.message);
      expect(turnFailureFramePayload(failure)).toEqual({
        code: quota.code,
        message: quota.message,
      });
      expect(JSON.stringify(failure)).not.toContain(canary);
    }
  });

  test("SQL errors and their wrappers cannot echo rejected content into stream failures", () => {
    const canary = "turn-database-private-content-canary";
    const query = new DrizzleQueryError(
      "insert into conversation_messages values ($1)",
      [canary],
      new Error("invalid byte sequence"),
    );
    for (const error of [query, new Error(`Conversation failed: ${canary}`, { cause: query })]) {
      const failure = describeTurnFailure(error, now);
      expect(failure).toEqual({
        code: "internal",
        message: "The conversation could not be saved.",
        at: now.toISOString(),
      });
      expect(JSON.stringify(turnFailureFramePayload(failure))).not.toContain(canary);
    }
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

test("provider tool schema rejection is not reported as a network outage", () => {
  expect(
    describeTurnFailure(
      new LlmProviderError("other", "tools.159.custom.input_schema: root oneOf is unsupported"),
      now,
    ).code,
  ).toBe("llm_tool_schema_invalid");
  expect(describeTurnFailure(new LlmProviderError("other", "connect ECONNREFUSED"), now).code).toBe(
    "llm_provider_unavailable",
  );
});

describe("providerFailureNotice", () => {
  const missingModel = new APICallError({
    message: "The model `gpt-unknown` does not exist or you do not have access to it.",
    url: "https://api.openai.com/v1/responses",
    requestBodyValues: {},
    statusCode: 404,
    isRetryable: false,
  });

  test("a missing model gives a short reply that points to the AI settings", () => {
    const de = providerFailureNotice(missingModel, "de");
    const en = providerFailureNotice(missingModel, "en");
    expect(de).toContain("Einstellungen → KI & Kosten");
    expect(de).toContain("Modell");
    expect(en).toContain("Settings → AI & cost");
    expect(en).not.toContain("gpt-unknown");
  });

  test("a missing model raised before the provider call is still explained", () => {
    for (const message of [
      "model_not_found: gpt-unknown",
      "The model `gpt-4.1-mini` does not exist or you do not have access to it.",
      "No such languageModel: openai:gpt-4.1-mini",
    ])
      expect(providerFailureNotice(new Error(message), "en")).toContain("configured AI model");
  });

  test("an unreachable provider points to the provider settings", () => {
    expect(
      providerFailureNotice(new LlmProviderError("other", "connect ECONNREFUSED"), "en"),
    ).toContain("AI provider did not answer");
  });

  test("a workspace without AI access is told where to enter its provider and key", () => {
    const missing = new LlmAccessMissing();
    expect(describeTurnFailure(missing, now)).toEqual({
      code: "ai_access_missing",
      message: missing.message,
      at: "2026-09-29T15:00:00.000Z",
    });
    expect(providerFailureNotice(missing, "de")).toContain("Einstellungen → KI-Assistent");
    expect(providerFailureNotice(missing, "en")).toContain("Settings → AI assistant");
  });

  test("quota, rate limits, timeouts and internal failures stay silent", () => {
    expect(providerFailureNotice(toLlmProviderError(new Error(QUOTA_SENTENCE)), "de")).toBeNull();
    expect(providerFailureNotice(new LlmProviderError("rate_limit", "429"), "de")).toBeNull();
    expect(providerFailureNotice(new LlmTimeoutError("total", 1_000), "de")).toBeNull();
    expect(providerFailureNotice(new Error("boom"), "de")).toBeNull();
  });
});
