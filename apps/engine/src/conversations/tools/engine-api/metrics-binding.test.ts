import { describe, expect, test } from "bun:test";
import { bindingCeiling } from "./metrics.ts";

describe("which ceiling refuses first", () => {
  test("the workspace binds when the caller has no personal cap", () => {
    expect(bindingCeiling(null, 115_822_246)).toBe("tenant");
  });

  test("the personal cap binds when the workspace has none", () => {
    expect(bindingCeiling(500, null)).toBe("user");
  });

  test("the tighter of the two binds", () => {
    expect(bindingCeiling(500, 9_000)).toBe("user");
    expect(bindingCeiling(9_000, 500)).toBe("tenant");
  });

  test("a tie goes to the personal cap, which the dispatch evaluates first", () => {
    expect(bindingCeiling(1_000, 1_000)).toBe("user");
  });

  test("nothing binds when neither ceiling exists", () => {
    expect(bindingCeiling(null, null)).toBeNull();
  });

  test("an exhausted ceiling still binds — zero left is not no cap", () => {
    expect(bindingCeiling(0, null)).toBe("user");
    expect(bindingCeiling(null, 0)).toBe("tenant");
    expect(bindingCeiling(0, 5_000)).toBe("user");
  });
});
