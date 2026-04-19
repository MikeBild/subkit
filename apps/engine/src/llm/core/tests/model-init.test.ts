// `initializeModel` — gateway-first resolver.
//
// Only two real outcomes exist now:
//   - Mock (tests + local without a gateway key).
//   - Gateway (Vercel AI Gateway, which itself routes to anthropic /
//     openai / google / bedrock / vertex / azure via the model string).
// The legacy per-provider SDK branches (`@ai-sdk/anthropic`,
// `@ai-sdk/openai`, `@ai-sdk/google`) were deleted — they were the root
// cause of a production 500 cluster (the compiled engine binary was
// missing the dynamically-imported packages).

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { initializeModel, ProviderMisconfiguredError } from "../model-init.ts";

const SAVED_ENV: Record<string, string | undefined> = {};
const TRACKED = ["AI_GATEWAY_API_KEY", "AI_GATEWAY_MODEL", "LLM_PROVIDER"];

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

  it("returns the mock sentinel when providerOverride=mock (tests bypass env)", async () => {
    const r = await initializeModel({ providerOverride: "mock" });
    expect(r.provider).toBe("mock");
    expect(r.model).toBe("mock:never-dispatched");
  });

  it("returns the gateway model string when AI_GATEWAY_API_KEY is set", async () => {
    process.env.AI_GATEWAY_API_KEY = "gw-key";
    process.env.AI_GATEWAY_MODEL = "anthropic/claude-sonnet-4-5";
    const r = await initializeModel();
    expect(r.provider).toBe("gateway");
    expect(r.modelId).toBe("anthropic/claude-sonnet-4-5");
    expect(r.model).toBe("anthropic/claude-sonnet-4-5");
  });

  it("uses the default model when AI_GATEWAY_MODEL is not set", async () => {
    process.env.AI_GATEWAY_API_KEY = "gw-key";
    const r = await initializeModel({ defaultModel: "anthropic/claude-haiku-4-5" });
    expect(r.provider).toBe("gateway");
    expect(r.modelId).toBe("anthropic/claude-haiku-4-5");
  });

  it("modelOverride wins over AI_GATEWAY_MODEL", async () => {
    process.env.AI_GATEWAY_API_KEY = "gw-key";
    process.env.AI_GATEWAY_MODEL = "anthropic/claude-sonnet-4-5";
    const r = await initializeModel({ modelOverride: "anthropic/claude-haiku-4-5" });
    expect(r.modelId).toBe("anthropic/claude-haiku-4-5");
  });

  it("throws ProviderMisconfiguredError when neither mock nor a gateway key is configured", async () => {
    // The real regression the old test cluster covered: we must NOT fall
    // back to the mock sentinel silently when LLM_PROVIDER is unset and
    // AI_GATEWAY_API_KEY is also unset. That previously caused every
    // production conversation to 500 via `mock:never-dispatched`.
    await expect(initializeModel()).rejects.toBeInstanceOf(ProviderMisconfiguredError);
  });

  it("honours providerEnvVar override for mock", async () => {
    process.env.CUSTOM_PROVIDER = "mock";
    const r = await initializeModel({ providerEnvVar: "CUSTOM_PROVIDER" });
    expect(r.provider).toBe("mock");
    delete process.env.CUSTOM_PROVIDER;
  });
});
