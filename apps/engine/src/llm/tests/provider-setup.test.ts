import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _resetConfigForTests } from "../../config/loader.ts";
import { testEnv } from "../../test-helpers/determinism/env.ts";
import { validateProviderSetup } from "../runtime/model-init.ts";

const ENV_KEYS = [
  "LLM_PROVIDER",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "AZURE_API_KEY",
  "AZURE_RESOURCE_NAME",
  "AZURE_BASE_URL",
  "AWS_REGION",
  "GOOGLE_VERTEX_PROJECT",
  "GOOGLE_VERTEX_LOCATION",
  "AI_GATEWAY_API_KEY",
  "AI_GATEWAY_MODEL",
];

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = testEnv[k];
    delete testEnv[k];
  }
  _resetConfigForTests();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete testEnv[k];
    else testEnv[k] = saved[k];
  }
  _resetConfigForTests();
});

describe("validateProviderSetup", () => {
  test("unconfigured when LLM_PROVIDER is absent", () => {
    const report = validateProviderSetup();
    expect(report.detected).toBe("unconfigured");
    expect(report.ok).toBe(false);
    expect(report.missing).toEqual(["LLM_PROVIDER"]);
  });

  test("anthropic ok when ANTHROPIC_API_KEY is set", () => {
    testEnv.LLM_PROVIDER = "anthropic";
    testEnv.ANTHROPIC_API_KEY = "sk-ant-test";
    const report = validateProviderSetup();
    expect(report.detected).toBe("anthropic");
    expect(report.ok).toBe(true);
    expect(report.missing).toEqual([]);
  });

  test("bedrock missing AWS_REGION surfaces the missing key", () => {
    testEnv.LLM_PROVIDER = "bedrock";
    const report = validateProviderSetup();
    expect(report.detected).toBe("bedrock");
    expect(report.ok).toBe(false);
    expect(report.missing).toContain("AWS_REGION");
    expect(report.message).toContain("AWS_REGION");
  });

  test("vertex requires both PROJECT and LOCATION", () => {
    testEnv.LLM_PROVIDER = "vertex";
    testEnv.GOOGLE_VERTEX_PROJECT = "p";
    const report = validateProviderSetup();
    expect(report.ok).toBe(false);
    expect(report.missing).toEqual(["GOOGLE_VERTEX_LOCATION"]);
  });

  test("azure with API key but neither resource_name nor base_url is misconfigured", () => {
    testEnv.LLM_PROVIDER = "azure";
    testEnv.AZURE_API_KEY = "k";
    const report = validateProviderSetup();
    expect(report.ok).toBe(false);
    expect(report.missing).toContain("AZURE_RESOURCE_NAME|AZURE_BASE_URL");
  });

  test("gateway ready when both AI_GATEWAY_* are set", () => {
    testEnv.AI_GATEWAY_API_KEY = "k";
    testEnv.AI_GATEWAY_MODEL = "m";
    const report = validateProviderSetup();
    expect(report.detected).toBe("gateway");
    expect(report.ok).toBe(true);
  });

  test("mock provider is always reported ready", () => {
    testEnv.LLM_PROVIDER = "mock";
    const report = validateProviderSetup();
    expect(report.detected).toBe("mock");
    expect(report.ok).toBe(true);
  });
});
