// Regression: production 500 cluster (v1.10.0) root cause.
//
// The engine used to dynamically import `@ai-sdk/anthropic` /
// `@ai-sdk/openai` / `@ai-sdk/google`. The compiled `bun --compile`
// binary shipped without those modules, so every real-LLM conversation
// threw `ProviderNotInstalledError` and surfaced as a 500 to sk.
//
// This test locks in the gateway-only contract:
//   1. Real-LLM paths MUST go through `ai`'s gateway mode — the model
//      value is a plain string, not a handle loaded via `createXxx`.
//   2. The compiled-binary-pinch bug is impossible because the
//      resolver never touches `@ai-sdk/*` provider packages.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { initializeModel, ProviderMisconfiguredError } from "../model-init.ts";

const KEYS = [
  "AI_GATEWAY_API_KEY",
  "AI_GATEWAY_MODEL",
  "LLM_PROVIDER",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
];

const SAVED: Record<string, string | undefined> = {};

function snapshot(): void {
  for (const k of KEYS) SAVED[k] = process.env[k];
  for (const k of KEYS) delete process.env[k];
}
function restore(): void {
  for (const k of KEYS) {
    const v = SAVED[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe("gateway-only LLM resolution — regression for the v1.10.0 production 500 cluster", () => {
  beforeEach(snapshot);
  afterEach(restore);

  it("hands back a plain string model (no per-provider handle) when AI_GATEWAY_API_KEY is set", async () => {
    process.env.AI_GATEWAY_API_KEY = "gw-key";
    const resolved = await initializeModel({
      defaultModel: "anthropic/claude-sonnet-4-5",
    });
    expect(resolved.provider).toBe("gateway");
    // The critical invariant: the resolver returns a STRING, not a
    // LanguageModel handle. A string means `ai.streamText({ model })`
    // routes through the gateway without needing `@ai-sdk/anthropic`
    // to be importable at runtime.
    expect(typeof resolved.model).toBe("string");
  });

  it("fails loudly when neither gateway nor mock is configured — no silent mock fallback in production", async () => {
    // The pre-fix engine silently fell back to the mock sentinel
    // when LLM_PROVIDER was unset; the sentinel then crashed on
    // dispatch. We now refuse to resolve, so the failure mode is a
    // deterministic boot-time error instead of a 500 per request.
    await expect(initializeModel()).rejects.toBeInstanceOf(ProviderMisconfiguredError);
  });

  it("does NOT attempt to import @ai-sdk/anthropic even when ANTHROPIC_API_KEY is set", async () => {
    // Anti-regression: the pre-fix code read ANTHROPIC_API_KEY and
    // called `await import('@ai-sdk/anthropic')` which failed in the
    // compiled binary. The gateway-only resolver must ignore
    // per-provider keys and still error out cleanly.
    process.env.ANTHROPIC_API_KEY = "sk-ant-fake";
    await expect(initializeModel()).rejects.toBeInstanceOf(ProviderMisconfiguredError);
  });

  it("does NOT attempt to import @ai-sdk/openai even when OPENAI_API_KEY is set", async () => {
    process.env.OPENAI_API_KEY = "sk-openai-fake";
    await expect(initializeModel()).rejects.toBeInstanceOf(ProviderMisconfiguredError);
  });
});
