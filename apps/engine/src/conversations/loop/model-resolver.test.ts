// Coverage for the SDK language-model resolver. The mock-vs-real
// branching is short but exactly the kind of dispatch that regresses
// silently when the SDK upgrades the provider registry signature.

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_BUDGET,
  type LoopProviderKind,
  MAX_REPAIRS_PER_TURN,
  resolveLanguageModel,
} from "./model-resolver.ts";

describe("resolveLanguageModel", () => {
  test("returns a fresh MockLanguageModelV3 for the mock provider", async () => {
    const model = await resolveLanguageModel("mock", "mock-sonnet");
    expect(model).toBeDefined();
    // Mock models expose the SDK v3 interface and a synthetic specVersion.
    expect(typeof (model as { specificationVersion?: unknown }).specificationVersion).toBe(
      "string",
    );
  });

  test("returns distinct mock-model instances on each call", async () => {
    const a = await resolveLanguageModel("mock", "mock-sonnet");
    const b = await resolveLanguageModel("mock", "mock-sonnet");
    expect(a).not.toBe(b);
  });

  test("real-provider path types check against LoopProviderKind union", () => {
    // Compile-only assertion: the union must include the SDK provider
    // kinds the loop ever passes. If the SDK adds/removes a provider
    // tag in `llm/types.ts:LlmProviderKind`, this site will surface
    // the change at typecheck time instead of through the runtime
    // `as any` cast that previously masked it.
    const providers: LoopProviderKind[] = [
      "mock",
      "anthropic",
      "openai",
      "gemini",
      "azure",
      "bedrock",
      "vertex",
      "gateway",
    ];
    // `void` to keep the test intent explicit: this is a typecheck
    // assertion, not a runtime assertion. Real-provider dispatch
    // (mock provider in test mode → resolveSdkModel(provider, modelId))
    // is covered by the orchestrator integration test at
    // `apps/engine/src/conversations/tests/loop.test.ts`, which drives
    // an end-to-end runLoop call against the SDK. Do not delete this
    // typecheck case without confirming that integration test still
    // pins the SDK contract.
    void providers;
    expect(providers.length).toBeGreaterThan(1);
  });
});

describe("loop budget constants", () => {
  test("DEFAULT_BUDGET is 24 — caps in-turn authoring churn (lowered from 50)", () => {
    // A turn cannot run 50 steps of build→dry_run→judge→edit repair churn.
    // 24 fits ground → author_workflow → dry_run → a couple of repairs,
    // and does not starve non-authoring multi-step turns.
    expect(DEFAULT_BUDGET).toBe(24);
  });

  test("MAX_REPAIRS_PER_TURN caps repair-tool-call at 2 per turn", () => {
    expect(MAX_REPAIRS_PER_TURN).toBe(2);
  });
});
