import { describe, expect, test } from "bun:test";
import { bytes, MISSING, stringValue } from "@/components/cockpit/table-columns";

// CUI-SEV-2 lives here: a value nobody sent is not zero, and a measured zero
// is not a missing value. Both directions are checked, because only enforcing
// one of them is how the list cells drifted apart in the first place.
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

describe("byte counts separate unmeasured from empty", () => {
  test("an unmeasured size reads as a missing value", () => {
    expect(bytes(null)).toBe(MISSING);
    expect(bytes(undefined)).toBe(MISSING);
    expect(bytes("1840")).toBe(MISSING);
    expect(bytes(Number.NaN)).toBe(MISSING);
  });

  test("a measured empty file reads as zero bytes", () => {
    expect(bytes(0)).toBe("0 B");
  });

  test("scales to the unit an operator can read", () => {
    expect(bytes(1023)).toBe("1023 B");
    expect(bytes(18_400)).toBe("18.0 KB");
    expect(bytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});
