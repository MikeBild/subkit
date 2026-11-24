import { describe, expect, test } from "bun:test";
import { REFUSAL_PAUSE_AFTER } from "./admission-refusals.ts";
import { FAILURE_PAUSE_AFTER } from "./failure-policy.ts";

describe("failure policy", () => {
  test("pauses a schedule after five failures in a row", () => {
    expect(FAILURE_PAUSE_AFTER).toBe(5);
  });

  test("refused admissions pause after the same number of attempts", () => {
    expect(REFUSAL_PAUSE_AFTER).toBe(FAILURE_PAUSE_AFTER);
  });
});
