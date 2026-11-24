import { describe, expect, test } from "bun:test";
import { roundBudget } from "./progress-model";

describe("round budget of the latest run", () => {
  test("counts the rounds used against the limit per run", () => {
    expect(roundBudget(6, 20)).toEqual({ used: 6, total: 20 });
  });

  test("without a run there is no ring", () => {
    expect(roundBudget(null, 20)).toBeNull();
    expect(roundBudget(undefined, 20)).toBeNull();
  });

  test("a missing or zero limit shows no ring", () => {
    expect(roundBudget(3, 0)).toBeNull();
    expect(roundBudget(3, null)).toBeNull();
  });

  test("never shows more than the limit or less than nothing", () => {
    expect(roundBudget(25, 20)).toEqual({ used: 20, total: 20 });
    expect(roundBudget(-2, 20)).toEqual({ used: 0, total: 20 });
  });
});
