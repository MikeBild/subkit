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
    void providers;
    expect(providers.length).toBeGreaterThan(1);
  });
});

describe("loop budget constants", () => {
  test("DEFAULT_BUDGET is 24 — caps in-turn authoring churn (lowered from 50)", () => {
    expect(DEFAULT_BUDGET).toBe(24);
  });

  test("MAX_REPAIRS_PER_TURN caps repair-tool-call at 2 per turn", () => {
    expect(MAX_REPAIRS_PER_TURN).toBe(2);
  });
});
