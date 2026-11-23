import { describe, expect, test } from "bun:test";
import { isNeverCovered } from "./never-covered.ts";

describe("actions that always ask", () => {
  test("an ordinary action with a known verb may be covered", () => {
    expect(isNeverCovered({ effect_class: "ordinary", verbs: ["send"] })).toBe(false);
  });

  test("every other effect class always asks", () => {
    for (const effect_class of [
      "payment",
      "deletion",
      "publication",
      "permission_or_settings",
      "account_creation",
      "credential",
      "unknown",
    ] as const)
      expect(isNeverCovered({ effect_class, verbs: ["send"] })).toBe(true);
  });

  test("an action without a known verb always asks", () => {
    expect(isNeverCovered({ effect_class: "ordinary", verbs: [] })).toBe(true);
  });
});
