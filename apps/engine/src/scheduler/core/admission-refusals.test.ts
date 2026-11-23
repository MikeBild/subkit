import { describe, expect, test } from "bun:test";
import {
  countRefusal,
  holdStillStands,
  REFUSAL_PAUSE_AFTER,
  refusalCountsTowardPause,
} from "./admission-refusals.ts";

describe("refused starts count toward the schedule pause", () => {
  test("the first refusal of a reason counts one", () => {
    expect(countRefusal(null, "execution_authority_expired")).toEqual({
      refusals: 1,
      pause: false,
    });
    expect(
      countRefusal({ reason_code: "execution_authority_expired" }, "execution_authority_expired"),
    ).toEqual({ refusals: 1, pause: false });
  });

  test("the same reason in a row adds up and pauses at the limit", () => {
    let hold = { reason_code: "execution_authority_revoked", refusals: 0 };
    for (let seen = 1; seen < REFUSAL_PAUSE_AFTER; seen++) {
      const next = countRefusal(hold, "execution_authority_revoked");
      expect(next).toEqual({ refusals: seen, pause: false });
      hold = { ...hold, refusals: next?.refusals ?? 0 };
    }
    expect(countRefusal(hold, "execution_authority_revoked")).toEqual({
      refusals: REFUSAL_PAUSE_AFTER,
      pause: true,
    });
  });

  test("a different reason starts over", () => {
    expect(
      countRefusal(
        { reason_code: "execution_authority_expired", refusals: 4 },
        "execution_authority_revoked",
      ),
    ).toEqual({ refusals: 1, pause: false });
  });

  test("a damaged count never goes below one", () => {
    expect(
      countRefusal(
        { reason_code: "execution_authority_changed", refusals: -7 },
        "execution_authority_changed",
      )?.refusals,
    ).toBe(1);
  });

  test("waiting for a first approval or for input never counts toward the pause", () => {
    for (const reason of ["execution_authority_required", "input_required"]) {
      expect(refusalCountsTowardPause(reason)).toBe(false);
      for (const refusals of [0, REFUSAL_PAUSE_AFTER - 1, REFUSAL_PAUSE_AFTER * 3]) {
        expect(countRefusal({ reason_code: reason, refusals }, reason)).toBeNull();
      }
    }
  });

  test("only an ended or changed approval counts toward the pause", () => {
    for (const reason of [
      "execution_authority_expired",
      "execution_authority_exhausted",
      "execution_authority_revoked",
      "execution_authority_changed",
    ]) {
      expect(refusalCountsTowardPause(reason)).toBe(true);
    }
    expect(refusalCountsTowardPause("constructor")).toBe(false);
  });
});

describe("a hold stands while the workflow still lacks its approval", () => {
  test("a missing approval stands for a repair and for a review", () => {
    expect(holdStillStands("execution_authority_required", "repair_required")).toBe(true);
    expect(holdStillStands("execution_authority_required", "approval_required")).toBe(true);
    expect(holdStillStands("execution_authority_required", "authorized")).toBe(false);
  });

  test("an ended approval stands until a new one is live", () => {
    for (const reason of [
      "execution_authority_expired",
      "execution_authority_exhausted",
      "execution_authority_revoked",
      "execution_authority_changed",
    ]) {
      expect(holdStillStands(reason, "approval_required")).toBe(true);
      expect(holdStillStands(reason, "repair_required")).toBe(false);
      expect(holdStillStands(reason, "authorized")).toBe(false);
    }
  });

  test("other reasons and unknown states do not stand", () => {
    expect(holdStillStands("input_required", "approval_required")).toBe(false);
    expect(holdStillStands(null, "approval_required")).toBe(false);
    expect(holdStillStands("execution_authority_expired", null)).toBe(false);
    expect(holdStillStands("constructor", "approval_required")).toBe(false);
  });
});
