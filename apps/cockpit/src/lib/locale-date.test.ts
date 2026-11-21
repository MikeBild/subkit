import { describe, expect, test } from "bun:test";
import { formatLocalValue, parseLocalValue } from "./locale-date";

describe("dates in the reader's format", () => {
  test("a stored date shows as 21.12.2026 in German and 12/21/2026 in English", () => {
    expect(formatLocalValue("2026-12-21", "de-DE")).toBe("21.12.2026");
    expect(formatLocalValue("2026-12-21", "en-US")).toBe("12/21/2026");
    expect(formatLocalValue("", "de-DE")).toBe("");
  });

  test("a stored date and time keep a 24-hour clock", () => {
    expect(formatLocalValue("2026-12-21T08:05", "de-DE", true)).toBe("21.12.2026, 08:05");
    expect(formatLocalValue("2026-12-21T18:30", "en-US", true)).toBe("12/21/2026, 18:30");
  });

  test("typed text reads back in the reader's order", () => {
    expect(parseLocalValue("21.12.2026", "de-DE")).toBe("2026-12-21");
    expect(parseLocalValue("1.2.26", "de-DE")).toBe("2026-02-01");
    expect(parseLocalValue("12/21/2026", "en-US")).toBe("2026-12-21");
    expect(parseLocalValue("21.12.2026, 08:05", "de-DE", true)).toBe("2026-12-21T08:05");
    expect(parseLocalValue("12/21/2026 18:30", "en-US", true)).toBe("2026-12-21T18:30");
  });

  test("an empty field is empty and a wrong date is refused", () => {
    expect(parseLocalValue("  ", "de-DE")).toBe("");
    expect(parseLocalValue("31.02.2026", "de-DE")).toBeNull();
    expect(parseLocalValue("21/12/2026", "en-US")).toBeNull();
    expect(parseLocalValue("morgen", "de-DE")).toBeNull();
    expect(parseLocalValue("21.12.2026, 25:00", "de-DE", true)).toBeNull();
  });

  test("what is shown reads back to the same value", () => {
    for (const tag of ["de-DE", "en-US"]) {
      expect(parseLocalValue(formatLocalValue("2026-03-09", tag), tag)).toBe("2026-03-09");
      expect(parseLocalValue(formatLocalValue("2026-03-09T07:45", tag, true), tag, true)).toBe(
        "2026-03-09T07:45",
      );
    }
  });
});
