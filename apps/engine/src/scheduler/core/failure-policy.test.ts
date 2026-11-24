import { describe, expect, test } from "bun:test";
import { REFUSAL_PAUSE_AFTER } from "./admission-refusals.ts";
import { FAILURE_PAUSE_AFTER } from "./failure-policy.ts";

describe("schedule failure pause policy", () => {
  test("a schedule pauses after five failures in a row", () => {
    expect(FAILURE_PAUSE_AFTER).toBe(5);
  });

  test("refused starts pause a schedule at the same streak as failed runs", () => {
    expect(REFUSAL_PAUSE_AFTER).toBe(FAILURE_PAUSE_AFTER);
  });
});
