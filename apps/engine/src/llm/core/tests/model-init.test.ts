import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { initializeModel, ProviderMisconfiguredError } from "../model-init.ts";

const SAVED_ENV: Record<string, string | undefined> = {};
const TRACKED = [
  "AI_GATEWAY_API_KEY",
  "AI_GATEWAY_MODEL",
  "LLM_PROVIDER",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "OPENAI_API_KEY",
  "OPENAI_MODEL",
  "GEMINI_API_KEY",
  "GEMINI_MODEL",
  "AZURE_API_KEY",
  "AZURE_MODEL",
  "AZURE_RESOURCE_NAME",
  "AWS_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "BEDROCK_MODEL",
  "VERTEX_API_KEY",
  "VERTEX_MODEL",
] as const;

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

  it("returns the mock sentinel when LLM_PROVIDER=mock", async () => {
    process.env.LLM_PROVIDER = "mock";
    const r = await initializeModel();
    expect(r.provider).toBe("mock");
    expect(r.model).toBe("mock:never-dispatched");
  });

  it("returns the mock sentinel when providerOverride=mock", async () => {
    const r = await initializeModel({ providerOverride: "mock" });
    expect(r.provider).toBe("mock");
    expect(r.model).toBe("mock:never-dispatched");
  });

  it("prefers gateway mode when both gateway vars are set", async () => {
    process.env.LLM_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.AI_GATEWAY_API_KEY = "gw-key";
    process.env.AI_GATEWAY_MODEL = "anthropic/claude-sonnet-4-5";
    const r = await initializeModel();
    expect(r.provider).toBe("gateway");
    expect(r.modelId).toBe("anthropic/claude-sonnet-4-5");
    expect(r.model).toBe("anthropic/claude-sonnet-4-5");
  });

  it("returns a direct anthropic model when LLM_PROVIDER=anthropic", async () => {
    process.env.LLM_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.ANTHROPIC_MODEL = "claude-sonnet-4-5";
    const r = await initializeModel();
    expect(r.provider).toBe("anthropic");
    expect(r.modelId).toBe("claude-sonnet-4-5");
    expect(typeof r.model).toBe("object");
  });

  it("returns a direct openai model when LLM_PROVIDER=openai", async () => {
    process.env.LLM_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-openai-test";
    process.env.OPENAI_MODEL = "gpt-4.1";
    const r = await initializeModel();
    expect(r.provider).toBe("openai");
    expect(r.modelId).toBe("gpt-4.1");
    expect(typeof r.model).toBe("object");
  });

  it("honours providerOverride over env-driven gateway selection", async () => {
    process.env.AI_GATEWAY_API_KEY = "gw-key";
    process.env.AI_GATEWAY_MODEL = "anthropic/claude-sonnet-4-5";
    process.env.OPENAI_API_KEY = "sk-openai-test";
    const r = await initializeModel({
      providerOverride: "openai",
      modelOverride: "gpt-4.1",
    });
    expect(r.provider).toBe("openai");
    expect(r.modelId).toBe("gpt-4.1");
    expect(typeof r.model).toBe("object");
  });

  it("throws when gateway is selected but AI_GATEWAY_MODEL is missing", async () => {
    process.env.AI_GATEWAY_API_KEY = "gw-key";
    await expect(initializeModel({ providerOverride: "gateway" })).rejects.toBeInstanceOf(
      ProviderMisconfiguredError,
    );
  });

  it("throws when LLM_PROVIDER is set but the matching key is missing", async () => {
    process.env.LLM_PROVIDER = "anthropic";
    await expect(initializeModel()).rejects.toBeInstanceOf(ProviderMisconfiguredError);
  });

  it("throws when neither gateway nor a provider env is configured", async () => {
    await expect(initializeModel()).rejects.toBeInstanceOf(ProviderMisconfiguredError);
  });

  it("honours providerEnvVar override for mock", async () => {
    process.env.CUSTOM_PROVIDER = "mock";
    const r = await initializeModel({ providerEnvVar: "CUSTOM_PROVIDER" });
    expect(r.provider).toBe("mock");
    delete process.env.CUSTOM_PROVIDER;
  });
});
