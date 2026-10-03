import { describe, expect, test } from "bun:test";
import { modelDisplayName } from "../model-names.ts";
import { MODEL_PRICE_CATALOG } from "../model-price-catalog.ts";

describe("modelDisplayName", () => {
  test("every catalog model has a name", () => {
    const missing = MODEL_PRICE_CATALOG.filter((price) => modelDisplayName(price.model) === null);
    expect(missing.map((price) => price.model)).toEqual([]);
  });

  test("a snapshot, a provider prefix and a platform id name the model they serve", () => {
    expect(modelDisplayName("claude-haiku-4-5-20251001")).toBe("Claude Haiku 4.5");
    expect(modelDisplayName("anthropic/claude-sonnet-4-5")).toBe("Claude Sonnet 4.5");
    expect(modelDisplayName("eu.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe(
      "Claude Haiku 4.5",
    );
    expect(modelDisplayName("claude-sonnet-4-5@20250929")).toBe("Claude Sonnet 4.5");
  });

  test("an unknown model has no name, so the id stands", () => {
    expect(modelDisplayName("my-local-model")).toBeNull();
    expect(modelDisplayName("")).toBeNull();
  });
});
