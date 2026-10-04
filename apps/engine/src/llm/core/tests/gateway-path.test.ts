import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { _resetConfigForTests } from "../../../config/loader.ts";
import { initializeModel, ProviderMisconfiguredError } from "../model-init.ts";

const KEYS = [
  "AI_GATEWAY_API_KEY",
  "AI_GATEWAY_MODEL",
  "LLM_PROVIDER",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
] as const;

const SAVED: Record<string, string | undefined> = {};

function snapshot(): void {
  for (const k of KEYS) SAVED[k] = process.env[k];
  for (const k of KEYS) delete process.env[k];
  // v3.5: drop any leaked loader state — readEnv reads getConfig
  // first and the schema "mock" default would override these
  // env-driven assertions.
  _resetConfigForTests();
}
function restore(): void {
  for (const k of KEYS) {
    const v = SAVED[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  _resetConfigForTests();
}

describe("provider resolution — regression for production 500s", () => {
  beforeEach(snapshot);
  afterEach(restore);

  it("hands back a plain string model in gateway mode", async () => {
    process.env.AI_GATEWAY_API_KEY = "gw-key";
    process.env.AI_GATEWAY_MODEL = "anthropic/claude-sonnet-4-5";
    const resolved = await initializeModel({
      defaultModel: "anthropic/claude-sonnet-4-5",
    });
    expect(resolved.provider).toBe("gateway");
    expect(typeof resolved.model).toBe("string");
  });

  it("supports direct anthropic mode when gateway vars are absent", async () => {
    process.env.LLM_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "sk-ant-fake";
    const resolved = await initializeModel({
      defaultModel: "claude-sonnet-4-5",
    });
    expect(resolved.provider).toBe("anthropic");
    expect(typeof resolved.model).toBe("object");
  });

  it("supports direct openai mode when gateway vars are absent", async () => {
    process.env.LLM_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-openai-fake";
    const resolved = await initializeModel({
      defaultModel: "gpt-4.1",
    });
    expect(resolved.provider).toBe("openai");
    expect(typeof resolved.model).toBe("object");
  });

  it("fails loudly when neither gateway nor a provider config is present", async () => {
    await expect(initializeModel()).rejects.toBeInstanceOf(ProviderMisconfiguredError);
  });
});
