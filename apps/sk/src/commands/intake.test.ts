import { describe, expect, test } from "bun:test";
import { intakeCategory, intakeItemId, intakeItemIds } from "./intake.ts";

const ONE = "10000000-0000-4000-8000-000000000001";
const TWO = "10000000-0000-4000-8000-000000000002";

describe("intake CLI selection", () => {
  test("uses a nonempty explicit category", () => {
    expect(intakeCategory(" Research ")).toBe("Research");
    expect(() => intakeCategory("")).toThrow("needs a category name");
  });

  test("accepts a bounded explicit UUID selection only", () => {
    expect(intakeItemIds(`${ONE},${TWO}`)).toEqual([ONE, TWO]);
    expect(intakeItemId(ONE)).toBe(ONE);
    expect(() => intakeItemId("not-an-id")).toThrow("--item needs a UUID");
    expect(() => intakeItemIds("not-an-id")).toThrow("comma-separated");
    expect(() => intakeItemIds(`${ONE},${ONE}`)).toThrow("same item twice");
    expect(() =>
      intakeItemIds(
        Array.from(
          { length: 101 },
          (_, index) => `${`${index}`.padStart(8, "0")}-0000-4000-8000-000000000001`,
        ).join(","),
      ),
    ).toThrow("at most 100");
  });
});
