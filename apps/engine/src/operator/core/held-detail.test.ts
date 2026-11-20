import { describe, expect, test } from "bun:test";
import { heldCauseClass, heldDetail } from "./held-detail.ts";

describe("a held schedule explains itself", () => {
  test("an unavailable approval names the remedy", () => {
    expect(heldDetail("execution_authority_unavailable")).toContain("Renew the approval");
    expect(heldCauseClass("execution_authority_unavailable")).toBe("authority_mismatch");
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
    expect(heldDetail("execution_authority_unavailable")).toBe(
      "The approval has expired, is used up or was revoked, so scheduled runs wait. Renew the approval to start them again. Nothing has run since the hold.",
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
