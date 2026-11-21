import { describe, expect, test } from "bun:test";
import { MISSING, stringValue } from "@/components/cockpit/table-columns";

describe("a missing number is never zero", () => {
  test("nothing at all reads as a missing value", () => {
    expect(stringValue(null)).toBe(MISSING);
    expect(stringValue(undefined)).toBe(MISSING);
    expect(stringValue("")).toBe(MISSING);
  });

  test("an empty list is a missing value, not a count of zero", () => {
    expect(stringValue([])).toBe(MISSING);
  });

  test("a non-empty list is its count", () => {
    expect(stringValue(["a", "b"])).toBe("2");
  });

  test("a measured zero stays a zero", () => {
    expect(stringValue(0)).toBe("0");
    expect(stringValue(false)).toBe("false");
  });
});
