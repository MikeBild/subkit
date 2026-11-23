import { describe, expect, test } from "bun:test";
import { parseAcceptedOperations } from "./accepted-operations.ts";

describe("parseAcceptedOperations", () => {
  test("no flag means the whole repair", () => {
    expect(parseAcceptedOperations(undefined)).toEqual({ ok: true, indices: undefined });
  });

  test("reads comma-separated zero-based numbers, sorted and without repeats", () => {
    expect(parseAcceptedOperations("2, 0,2")).toEqual({ ok: true, indices: [0, 2] });
    expect(parseAcceptedOperations("0")).toEqual({ ok: true, indices: [0] });
  });

  test("refuses anything that is not a whole number from zero", () => {
    for (const raw of ["", "a", "1,", "-1", "1.5", "0x1", "1 2", "all"]) {
      expect(parseAcceptedOperations(raw).ok).toBe(false);
    }
    expect(parseAcceptedOperations("99999999999999999999").ok).toBe(false);
  });
});
