import { describe, expect, test } from "bun:test";
import { APICallError } from "ai";
import { probeLlmAccess, probeVerdict } from "./access-probe.ts";

function apiError(statusCode: number, message = "request failed"): APICallError {
  return new APICallError({
    message,
    url: "https://provider.example.com/v1/messages",
    requestBodyValues: {},
    statusCode,
    responseBody: '{"error":{"message":"invalid x-api-key sk-ant-secret"}}',
  });
}

describe("probeVerdict — what a failed probe call means for the key", () => {
  test("401 and 403 say the key was rejected without echoing the provider's text", () => {
    for (const status of [401, 403]) {
      const verdict = probeVerdict(apiError(status), "anthropic", "claude-haiku-4-5");
      expect(verdict).toEqual({
        ok: false,
        model: "claude-haiku-4-5",
        reason: `anthropic rejected the API key (HTTP ${status})`,
      });
      expect(JSON.stringify(verdict)).not.toContain("sk-ant-secret");
    }
  });

  test("a rate limit means the key was accepted", () => {
    expect(probeVerdict(apiError(429), "openai", "gpt-4.1-mini").ok).toBe(true);
  });

  test("an empty balance, an unknown model and other refusals are named", () => {
    expect(probeVerdict(apiError(400, "Your credit balance is too low"), "anthropic", "m")).toEqual(
      {
        ok: false,
        model: "m",
        reason: "anthropic accepted the API key but has no quota or credit left",
      },
    );
    expect(probeVerdict(apiError(404), "openai", "gpt-x")).toEqual({
      ok: false,
      model: "gpt-x",
      reason: "openai does not offer the model gpt-x to this key",
    });
    expect(probeVerdict(apiError(400), "gemini", "m").ok).toBe(false);
  });

  test("an outage or no answer is not blamed on the key", () => {
    expect(probeVerdict(apiError(503), "anthropic", "m")).toEqual({
      ok: false,
      model: "m",
      reason: "anthropic is not available right now (HTTP 503)",
    });
    const timeout = Object.assign(new Error("The operation timed out."), { name: "TimeoutError" });
    expect(probeVerdict(timeout, "anthropic", "m", 20_000)).toEqual({
      ok: false,
      model: "m",
      reason: "anthropic did not answer within 20 seconds",
    });
    expect(probeVerdict(new Error("fetch failed"), "anthropic", "m")).toEqual({
      ok: false,
      model: "m",
      reason: "anthropic could not be reached",
    });
  });
});

describe("probeLlmAccess — one minimal call through the model client", () => {
  test("the mock provider passes without a call", async () => {
    let calls = 0;
    const result = await probeLlmAccess(
      { provider: "mock", api_key: "anything" },
      {
        generate: (async () => {
          calls += 1;
          throw new Error("must not be called");
        }) as never,
      },
    );
    expect(result).toEqual({ ok: true, model: null });
    expect(calls).toBe(0);
  });

  test("a key the provider accepts passes, and the call stays minimal", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const result = await probeLlmAccess(
      { provider: "anthropic", api_key: "sk-ant-probe" },
      {
        generate: (async (options: Record<string, unknown>) => {
          seen.push(options);
          return {};
        }) as never,
      },
    );
    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.maxOutputTokens).toBe(16);
    expect(seen[0]?.maxRetries).toBe(0);
  });

  test("a key the provider refuses fails with the reason", async () => {
    const result = await probeLlmAccess(
      { provider: "openai", api_key: "sk-wrong" },
      {
        generate: (async () => {
          throw apiError(401);
        }) as never,
      },
    );
    expect(result).toEqual(
      expect.objectContaining({ ok: false, reason: "openai rejected the API key (HTTP 401)" }),
    );
  });
});
