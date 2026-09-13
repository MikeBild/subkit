// Locks the validateProviderSetup() report shape — surfaced via
// /v1/status so the CLI status line can warn before the first turn.
//
// v3.5: readEnv() reads getConfig() FIRST and falls back to env. Tests
// here must run with a fresh loader state so a previously-loaded
// config (with llm.provider="mock" default) doesn't pollute their
// process.env-driven assertions.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { _resetConfigForTests } from "../../config/loader.ts";
import { validateProviderSetup } from "../core/model-init.ts";

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
    saved[k] = process.env[k];
    delete process.env[k];
  }
  // Drop any config state leaked from earlier suites (the schema
  // default for llm.provider is "mock", which overrides the absence
  // of LLM_PROVIDER in env unless we reset).
  _resetConfigForTests();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
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
    process.env.LLM_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const report = validateProviderSetup();
    expect(report.detected).toBe("anthropic");
    expect(report.ok).toBe(true);
    expect(report.missing).toEqual([]);
  });

  test("bedrock missing AWS_REGION surfaces the missing key", () => {
    process.env.LLM_PROVIDER = "bedrock";
    const report = validateProviderSetup();
    expect(report.detected).toBe("bedrock");
    expect(report.ok).toBe(false);
    expect(report.missing).toContain("AWS_REGION");
    expect(report.message).toContain("AWS_REGION");
  });

  test("vertex requires both PROJECT and LOCATION", () => {
    process.env.LLM_PROVIDER = "vertex";
    process.env.GOOGLE_VERTEX_PROJECT = "p";
    const report = validateProviderSetup();
    expect(report.ok).toBe(false);
    expect(report.missing).toEqual(["GOOGLE_VERTEX_LOCATION"]);
  });

  test("azure with API key but neither resource_name nor base_url is misconfigured", () => {
    process.env.LLM_PROVIDER = "azure";
    process.env.AZURE_API_KEY = "k";
    const report = validateProviderSetup();
    expect(report.ok).toBe(false);
    expect(report.missing).toContain("AZURE_RESOURCE_NAME|AZURE_BASE_URL");
  });

  test("gateway ready when both AI_GATEWAY_* are set", () => {
    process.env.AI_GATEWAY_API_KEY = "k";
    process.env.AI_GATEWAY_MODEL = "m";
    const report = validateProviderSetup();
    expect(report.detected).toBe("gateway");
    expect(report.ok).toBe(true);
  });

  test("mock provider is always reported ready", () => {
    process.env.LLM_PROVIDER = "mock";
    const report = validateProviderSetup();
    expect(report.detected).toBe("mock");
    expect(report.ok).toBe(true);
  });
});
