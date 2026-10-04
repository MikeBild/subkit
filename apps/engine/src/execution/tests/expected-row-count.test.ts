import { describe, expect, test } from "bun:test";
import { evaluateExpectedRowCount } from "../expected-row-count.ts";

describe("evaluateExpectedRowCount · number form", () => {
  test("exact match returns null", () => {
    expect(evaluateExpectedRowCount(5, 5)).toBeNull();
  });
  test("mismatch surfaces the violation message", () => {
    expect(evaluateExpectedRowCount(5, 7)).toContain("exactly 5");
    expect(evaluateExpectedRowCount(5, 7)).toContain("got 7");
  });
});

describe("evaluateExpectedRowCount · tuple form", () => {
  test("inside the range returns null", () => {
    expect(evaluateExpectedRowCount([1, 10], 5)).toBeNull();
  });
  test("equal to lo or hi is inside", () => {
    expect(evaluateExpectedRowCount([1, 10], 1)).toBeNull();
    expect(evaluateExpectedRowCount([1, 10], 10)).toBeNull();
  });
  test("below the range fails", () => {
    expect(evaluateExpectedRowCount([1, 10], 0)).toContain("[1, 10]");
  });
  test("above the range fails", () => {
    expect(evaluateExpectedRowCount([1, 10], 11)).toContain("[1, 10]");
  });
});

describe("evaluateExpectedRowCount · object form", () => {
  test("min only — actual ≥ min passes", () => {
    expect(evaluateExpectedRowCount({ min: 1 }, 5)).toBeNull();
    expect(evaluateExpectedRowCount({ min: 5 }, 5)).toBeNull();
  });
  test("min only — actual < min fails with `at least` phrasing", () => {
    const out = evaluateExpectedRowCount({ min: 5 }, 3);
    expect(out).toContain("at least 5");
    expect(out).toContain("got 3");
  });
  test("max only — actual ≤ max passes", () => {
    expect(evaluateExpectedRowCount({ max: 10 }, 5)).toBeNull();
    expect(evaluateExpectedRowCount({ max: 10 }, 10)).toBeNull();
  });
  test("max only — actual > max fails with `at most` phrasing", () => {
    const out = evaluateExpectedRowCount({ max: 10 }, 12);
    expect(out).toContain("at most 10");
    expect(out).toContain("got 12");
  });
  test("min + max — both bounds enforced", () => {
    expect(evaluateExpectedRowCount({ min: 1, max: 5 }, 3)).toBeNull();
    expect(evaluateExpectedRowCount({ min: 1, max: 5 }, 0)).toContain("at least 1");
    expect(evaluateExpectedRowCount({ min: 1, max: 5 }, 7)).toContain("at most 5");
  });
});
