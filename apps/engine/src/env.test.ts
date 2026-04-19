import { describe, expect, test } from "bun:test";
import { listLlmEnvironmentIssues, validateLlmEnvironment } from "./env.ts";

describe("validateLlmEnvironment", () => {
  test("allows an entirely unset LLM env during import-time parsing", () => {
    expect(() => validateLlmEnvironment({})).not.toThrow();
  });

  test("rejects partial gateway configuration", () => {
    expect(() =>
      validateLlmEnvironment({
        AI_GATEWAY_API_KEY: "gw-key",
      }),
    ).toThrow("AI_GATEWAY_API_KEY and AI_GATEWAY_MODEL must be set together");
  });

  test("rejects a missing provider credential", () => {
    expect(() =>
      validateLlmEnvironment({
        LLM_PROVIDER: "anthropic",
      }),
    ).toThrow("ANTHROPIC_API_KEY is required for anthropic mode");
  });

  test("rejects a misconfigured fallback provider", () => {
    expect(() =>
      validateLlmEnvironment({
        LLM_PROVIDER: "openai",
        OPENAI_API_KEY: "sk-openai-test",
        LLM_FALLBACK_PROVIDER: "bedrock",
      }),
    ).toThrow("LLM_FALLBACK_PROVIDER: AWS_REGION is required for bedrock mode");
  });

  test("can require a configured provider for real server startup", () => {
    expect(() => validateLlmEnvironment({}, { requireConfigured: true })).toThrow(
      "No LLM provider configured",
    );
    expect(() =>
      validateLlmEnvironment(
        {
          AI_GATEWAY_API_KEY: "gw-key",
          AI_GATEWAY_MODEL: "anthropic/claude-sonnet-4-5",
        },
        { requireConfigured: true },
      ),
    ).not.toThrow();
  });

  test("can validate the summarize override independently", () => {
    const issues = listLlmEnvironmentIssues(
      {
        LLM_PROVIDER: "mock",
        SUMMARIZE_LLM_PROVIDER: "anthropic",
      },
      {
        providerEnvVar: "SUMMARIZE_LLM_PROVIDER",
        fallbackProviderEnvVar: null,
        requireConfigured: true,
      },
    );
    expect(issues).toContain(
      "SUMMARIZE_LLM_PROVIDER: ANTHROPIC_API_KEY is required for anthropic mode",
    );
  });
});
