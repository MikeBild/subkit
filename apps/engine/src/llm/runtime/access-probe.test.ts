import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APICallError } from "ai";
import { _resetConfigForTests, loadConfig } from "../../config/loader.ts";
import { probeLlmAccess, probeModel, probeVerdict } from "./access-probe.ts";

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
        code: "key_rejected",
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
        code: "key_rejected",
        reason: "anthropic accepted the API key but has no quota or credit left",
      },
    );
    expect(probeVerdict(apiError(404), "openai", "gpt-x")).toEqual({
      ok: false,
      model: "gpt-x",
      code: "model_unavailable",
      reason: "openai does not offer the model gpt-x to this key",
    });
    expect(probeVerdict(apiError(400), "gemini", "m")).toMatchObject({
      ok: false,
      code: "key_rejected",
    });
  });

  test("an outage or no answer is not blamed on the key", () => {
    expect(probeVerdict(apiError(503), "anthropic", "m")).toEqual({
      ok: false,
      model: "m",
      code: "unreachable",
      reason: "anthropic is not available right now (HTTP 503)",
    });
    const timeout = Object.assign(new Error("The operation timed out."), { name: "TimeoutError" });
    expect(probeVerdict(timeout, "anthropic", "m", 20_000)).toEqual({
      ok: false,
      model: "m",
      code: "unreachable",
      reason: "anthropic did not answer within 20 seconds",
    });
    expect(probeVerdict(new Error("fetch failed"), "anthropic", "m")).toEqual({
      ok: false,
      model: "m",
      code: "unreachable",
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

describe("probeModel — which model the first-start check uses", () => {
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "sk-probe-model-"));
    const file = join(dir, "subkit.config.json");
    writeFileSync(
      file,
      JSON.stringify({
        llm: {
          provider: "openai",
          model: "gpt-primary",
          providers: { anthropic: { model: "claude-configured" } },
        },
      }),
    );
    _resetConfigForTests();
    await loadConfig({
      env: { DATABASE_URL: "postgres://placeholder/probe-model", NODE_ENV: "test" },
      configPathOverride: file,
    });
  });

  afterAll(() => {
    _resetConfigForTests();
  });

  test("a model passed to sk init wins", () => {
    expect(probeModel("anthropic", "claude-chosen")).toBe("claude-chosen");
    expect(probeModel("azure", " my-deployment ")).toBe("my-deployment");
  });

  test("then the provider's own configured model", () => {
    expect(probeModel("anthropic")).toBe("claude-configured");
  });

  test("llm.model counts only for the provider it belongs to", () => {
    expect(probeModel("openai")).toBe("gpt-primary");
    expect(probeModel("gemini")).toBe("gemini-2.5-flash");
  });

  test("azure and bedrock have no default and say which sk init flag to pass", async () => {
    expect(probeModel("azure")).toBeUndefined();
    expect(probeModel("bedrock")).toBeUndefined();
    const generate = (async () => ({})) as never;
    const azure = await probeLlmAccess({ provider: "azure", api_key: "k" }, { generate });
    expect(azure).toEqual({
      ok: false,
      model: null,
      code: "misconfigured",
      reason:
        "azure needs a model before the first start; pass it with sk init --llm-model <deployment name>",
    });
    const bedrock = await probeLlmAccess({ provider: "bedrock", api_key: "k" }, { generate });
    expect(bedrock.ok).toBe(false);
    if (!bedrock.ok) expect(bedrock.reason).toContain("sk init --llm-model <model id>");
  });

  test("a missing provider setting is named without pointing at the Cockpit", async () => {
    const result = await probeLlmAccess(
      { provider: "bedrock", api_key: "k", model: "anthropic.claude" },
      { generate: (async () => ({})) as never },
    );
    expect(result).toEqual({
      ok: false,
      model: "anthropic.claude",
      code: "misconfigured",
      reason:
        "bedrock needs AWS_REGION in the engine environment before the first start; set it and run sk init again",
    });
    expect(JSON.stringify(result)).not.toContain("Cockpit");
  });
});
