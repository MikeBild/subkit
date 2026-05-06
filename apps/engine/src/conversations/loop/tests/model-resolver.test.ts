// Coverage for the SDK language-model resolver. The mock-vs-real
// branching is short but exactly the kind of dispatch that regresses
// silently when the SDK upgrades the provider registry signature.

import { describe, expect, test } from "bun:test";
import { DEFAULT_BUDGET, MAX_REPAIRS_PER_TURN, resolveLanguageModel } from "../model-resolver.ts";

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
});

describe("loop budget constants", () => {
  test("DEFAULT_BUDGET is 50 (matches the SDK reference impl)", () => {
    expect(DEFAULT_BUDGET).toBe(50);
  });

  test("MAX_REPAIRS_PER_TURN caps repair-tool-call at 2 per turn", () => {
    expect(MAX_REPAIRS_PER_TURN).toBe(2);
  });
});
