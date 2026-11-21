import { describe, expect, test } from "bun:test";
import { workSteps } from "./progress-model";

describe("work steps of the latest run", () => {
  test("counts the rounds used against the limit per run", () => {
    expect(workSteps(6, 20)).toEqual({ used: 6, total: 20 });
  });

  test("without a run there is no ring", () => {
    expect(workSteps(null, 20)).toBeNull();
    expect(workSteps(undefined, 20)).toBeNull();
  });

  test("a missing or zero limit shows no ring", () => {
    expect(workSteps(3, 0)).toBeNull();
    expect(workSteps(3, null)).toBeNull();
  });

  test("never shows more than the limit or less than nothing", () => {
    expect(workSteps(25, 20)).toEqual({ used: 20, total: 20 });
    expect(workSteps(-2, 20)).toEqual({ used: 0, total: 20 });
  });
});
