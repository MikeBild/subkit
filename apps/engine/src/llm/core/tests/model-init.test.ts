import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { initializeModel, ProviderMisconfiguredError } from "../model-init.ts";

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
});
