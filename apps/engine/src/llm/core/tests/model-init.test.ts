import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  initializeModel,
  ProviderMisconfiguredError,
  ProviderNotInstalledError,
} from "../model-init.ts";

const SAVED_ENV: Record<string, string | undefined> = {};
const TRACKED = [
  "AI_GATEWAY_API_KEY",
  "AI_GATEWAY_MODEL",
  "LLM_PROVIDER",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_MODEL",
  "GEMINI_API_KEY",
];

function snapshotEnv() {
  for (const k of TRACKED) SAVED_ENV[k] = process.env[k];
}
function restoreEnv() {
  for (const k of TRACKED) {
    const v = SAVED_ENV[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
}
function clearEnv() {
  for (const k of TRACKED) delete process.env[k];
}

describe("initializeModel", () => {
  beforeEach(() => {
    snapshotEnv();
    clearEnv();
  });
  afterEach(() => {
    restoreEnv();
  });

  it("returns mock sentinel when no env is set", async () => {
    const r = await initializeModel();
    expect(r.provider).toBe("mock");
    expect(r.model).toBe("mock:never-dispatched");
  });

  it("returns gateway string when AI_GATEWAY_API_KEY+MODEL are set", async () => {
    process.env.AI_GATEWAY_API_KEY = "gw-key";
    process.env.AI_GATEWAY_MODEL = "anthropic/claude-sonnet-4-5";
    const r = await initializeModel();
    expect(r.provider).toBe("gateway");
    expect(r.modelId).toBe("anthropic/claude-sonnet-4-5");
    expect(r.model).toBe("anthropic/claude-sonnet-4-5");
  });

  it("uses modelOverride when gateway", async () => {
    process.env.AI_GATEWAY_API_KEY = "gw-key";
    process.env.AI_GATEWAY_MODEL = "anthropic/claude-sonnet-4-5";
    const r = await initializeModel({ modelOverride: "anthropic/claude-haiku-4-5" });
    expect(r.modelId).toBe("anthropic/claude-haiku-4-5");
  });

  it("throws ProviderMisconfiguredError when LLM_PROVIDER=anthropic but no API key", async () => {
    process.env.LLM_PROVIDER = "anthropic";
    await expect(initializeModel()).rejects.toBeInstanceOf(ProviderMisconfiguredError);
  });

  it("rejects unknown LLM_PROVIDER with actionable message", async () => {
    process.env.LLM_PROVIDER = "not-a-real-provider";
    await expect(initializeModel()).rejects.toBeInstanceOf(ProviderMisconfiguredError);
  });

  it("rejects stubbed providers (azure/bedrock/vertex) pointing to gateway", async () => {
    process.env.LLM_PROVIDER = "azure";
    await expect(initializeModel()).rejects.toBeInstanceOf(ProviderMisconfiguredError);
  });

  it("honours providerEnvVar override", async () => {
    process.env.CUSTOM_PROVIDER = "mock";
    const r = await initializeModel({ providerEnvVar: "CUSTOM_PROVIDER" });
    expect(r.provider).toBe("mock");
    delete process.env.CUSTOM_PROVIDER;
  });

  // Regression — the production 500 cluster on POST /v1/conversations
  // was caused by `resolveLanguageModel` calling initializeModel without
  // `providerOverride`. With LLM_PROVIDER unset but ANTHROPIC_API_KEY
  // present, currentProvider() inferred "anthropic" but initializeModel
  // re-read LLM_PROVIDER (empty), returned the "mock:never-dispatched"
  // sentinel, and streamText then threw on dispatch. The override path
  // MUST win over the env so the route's decision actually flows
  // through to the SDK.
  it("providerOverride beats LLM_PROVIDER (unset) — the dispatch must not silently fall back to mock", async () => {
    delete process.env.LLM_PROVIDER;
    process.env.ANTHROPIC_API_KEY = "sk-ant-fake";
    // `@ai-sdk/anthropic` is an OPTIONAL transitive dep; in CI with
    // strict peer resolution it may not be hoisted. Either outcome
    // proves the override is honoured (instead of the silent mock
    // fallback that caused the production 500 cluster this test
    // gates).
    try {
      const r = await initializeModel({
        providerOverride: "anthropic",
        defaultModel: "claude-sonnet-4-5",
      });
      expect(r.provider).toBe("anthropic");
      expect(r.modelId).toBe("claude-sonnet-4-5");
      expect(r.model).not.toBe("mock:never-dispatched");
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderNotInstalledError);
    }
  });

  it("providerOverride still surfaces ProviderMisconfiguredError when the chosen provider lacks credentials", async () => {
    delete process.env.LLM_PROVIDER;
    delete process.env.ANTHROPIC_API_KEY;
    await expect(initializeModel({ providerOverride: "anthropic" })).rejects.toBeInstanceOf(
      ProviderMisconfiguredError,
    );
  });

  it("providerOverride beats a conflicting LLM_PROVIDER env value", async () => {
    process.env.LLM_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-openai";
    process.env.ANTHROPIC_API_KEY = "sk-ant-fake";
    // Same optional-dep tolerance: either the override lands on the
    // anthropic provider (local dev), or the import fails loudly with
    // ProviderNotInstalledError (CI strict-peer environment).
    try {
      const r = await initializeModel({
        providerOverride: "anthropic",
        defaultModel: "claude-sonnet-4-5",
      });
      expect(r.provider).toBe("anthropic");
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderNotInstalledError);
    }
  });
});
