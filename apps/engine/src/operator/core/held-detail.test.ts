import { describe, expect, test } from "bun:test";
import { HELD_DETAIL_COPY } from "../../http/i18n/held-detail.ts";
import { heldCauseClass, heldDetail, heldDetailKey } from "./held-detail.ts";

describe("a held schedule explains itself", () => {
  test("an expired approval names the remedy", () => {
    expect(heldDetail("execution_authority_expired")).toContain("Renew the approval");
    expect(heldCauseClass("execution_authority_expired")).toBe("authority_mismatch");
  });

  test("expired, used up, revoked and changed each read differently", () => {
    const details = [
      "execution_authority_expired",
      "execution_authority_exhausted",
      "execution_authority_revoked",
      "execution_authority_changed",
    ].map((reason) => heldDetail(reason));
    expect(new Set(details).size).toBe(4);
    expect(details[1]).toContain("used up");
    expect(details[2]).toContain("revoked");
    expect(details[3]).toContain("does not cover");
    for (const detail of details) expect(detail).toContain("Nothing has run since the hold.");
  });

  test("the removed catch-all reason has no detail", () => {
    expect(heldDetail(["execution", "authority", "unavailable"].join("_"))).toBeNull();
  });

  test("every reason has a key with copy in both languages", () => {
    for (const reason of [
      "execution_authority_required",
      "execution_authority_expired",
      "execution_authority_exhausted",
      "execution_authority_revoked",
      "execution_authority_changed",
      "input_required",
    ]) {
      const key = heldDetailKey(reason);
      expect(key).toBe(`held.${reason}` as typeof key);
      if (!key) throw new Error("missing key");
      expect(HELD_DETAIL_COPY.en[key].length).toBeGreaterThan(20);
      expect(HELD_DETAIL_COPY.de[key].length).toBeGreaterThan(20);
      expect(heldDetail(reason)).toBe(HELD_DETAIL_COPY.en[key]);
      expect(HELD_DETAIL_COPY.de[key]).not.toContain("!");
    }
  });

  test("a missing approval asks for a review", () => {
    expect(heldDetail("execution_authority_required")).toContain("Review and approve");
    expect(heldCauseClass("execution_authority_required")).toBe("authority_mismatch");
  });

  test("missing input is not an approval problem", () => {
    expect(heldDetail("input_required")).toContain("missing input");
    expect(heldCauseClass("input_required")).toBeNull();
  });

  test("each held reason reads as its published sentence", () => {
    expect(heldDetail("execution_authority_required")).toBe(
      "No approval covers the current version, so scheduled runs wait. Review and approve the workflow to start them again. Nothing has run since the hold.",
    );
    expect(heldDetail("execution_authority_expired")).toBe(
      "The approval has expired, so scheduled runs wait. Renew the approval to start them again. Nothing has run since the hold.",
    );
    expect(heldDetail("input_required")).toBe(
      "The schedule has no input for a required field, so scheduled runs wait. Add the missing input to start them again.",
    );
  });

  test("only the approval prefix marks an authority cause", () => {
    expect(heldCauseClass("execution_authority_changed")).toBe("authority_mismatch");
    expect(heldCauseClass("execution_authority")).toBeNull();
    expect(heldCauseClass("schedule_execution_authority_required")).toBeNull();
    expect(heldCauseClass("")).toBeNull();
  });

  test("an unknown reason stays silent", () => {
    expect(heldDetail("something_else")).toBeNull();
    expect(heldDetail(null)).toBeNull();
    expect(heldDetail(undefined)).toBeNull();
    expect(heldDetail("")).toBeNull();
    expect(heldCauseClass(undefined)).toBeNull();
    expect(heldCauseClass(null)).toBeNull();
  });
  test("names of built-in object members are not hold reasons", () => {
    expect(heldDetail("toString")).toBeNull();
    expect(heldDetail("constructor")).toBeNull();
    expect(heldDetail("__proto__")).toBeNull();
  });
});
