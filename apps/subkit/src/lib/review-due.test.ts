import { describe, expect, test } from "bun:test";
import { reviewDueValue } from "./review-due.ts";

describe("reviewDueValue", () => {
  test("turns a calendar date into midnight UTC", () => {
    expect(reviewDueValue("2026-12-31")).toBe("2026-12-31T00:00:00.000Z");
  });

  test("normalizes a full ISO time with an offset", () => {
    expect(reviewDueValue("2026-12-31T10:00:00+01:00")).toBe("2026-12-31T09:00:00.000Z");
  });

  test("clears the date with none, never or clear", () => {
    expect(reviewDueValue("none")).toBeNull();
    expect(reviewDueValue(" Never ")).toBeNull();
    expect(reviewDueValue("clear")).toBeNull();
  });

  test("rejects anything else", () => {
    expect(() => reviewDueValue("next week")).toThrow("--review-due");
    expect(() => reviewDueValue("2026-13-45")).toThrow("--review-due");
    expect(() => reviewDueValue("2026-12-31T10:00:00")).toThrow("--review-due");
  });
});
