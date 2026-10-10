import { describe, expect, test } from "bun:test";
import { validateAgainstJsonSchema } from "../execution/engine/envelope.ts";
import { stripCalendarGates } from "./calendar-gates.ts";

describe("scheduled workflow input", () => {
  test("calendar-only object remains valid input for a strict empty object schema", () => {
    const input = stripCalendarGates({ business_days_only: false, skip_dates: [] });
    expect(
      validateAgainstJsonSchema(
        input,
        { type: "object", properties: {}, additionalProperties: false },
        "$input",
      ),
    ).toEqual({ valid: true, errors: [] });
    expect(input).toEqual({});
  });

  test("removes calendar metadata without changing workflow values or source data", () => {
    const source = { business_days_only: true, skip_dates: [], report: { active: true } };
    expect(stripCalendarGates(source)).toEqual({ report: { active: true } });
    expect(source.business_days_only).toBe(true);
  });

  test("preserves explicit null, absent input and other input shapes", () => {
    expect(stripCalendarGates(null)).toBeNull();
    expect(stripCalendarGates(undefined)).toBeNull();
    expect(stripCalendarGates({})).toEqual({});
    expect(stripCalendarGates([1])).toEqual([1]);
    expect(stripCalendarGates("value")).toBe("value");
    expect(stripCalendarGates(0)).toBe(0);
  });
});
