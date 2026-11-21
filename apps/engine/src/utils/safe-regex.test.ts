import { describe, expect, test } from "bun:test";
import {
  isSafeRegex,
  SAFE_REGEX_MAX_INPUT,
  SAFE_REGEX_MAX_PATTERN,
  safeRegex,
  UnsafeRegexError,
  unsafeRegexReason,
} from "./safe-regex.ts";

describe("unsafeRegexReason", () => {
  test("accepts ordinary patterns", () => {
    for (const pattern of [
      "^[A-Z]{2}\\d{4}$",
      "^\\S+@\\S+\\.\\S+$",
      "(ab)+",
      "(?:abc){1,3}",
      "token|secret|password",
      "^(a|b)$",
      "\\w+\\s*\\w+",
      "[(|)+*]+",
      "(?<year>\\d{4})-(\\d{2})?",
      "a{2}(b?)+",
    ])
      expect(unsafeRegexReason(pattern)).toBeNull();
  });

  test("refuses nested quantifiers", () => {
    for (const pattern of ["(a+)+", "(a*)*", "(\\w+\\s?)*$", "((ab)*c)+", "(a{1,5}){2,}"])
      expect(unsafeRegexReason(pattern)).toBe("nested_quantifier");
  });

  test("refuses alternation under a quantifier", () => {
    for (const pattern of ["(a|aa)+", "(?:x|y)*", "((a|b)c){2,9}"])
      expect(unsafeRegexReason(pattern)).toBe("alternation_under_quantifier");
  });

  test("refuses backreferences, long and unbalanced patterns", () => {
    expect(unsafeRegexReason("(a)\\1")).toBe("backreference");
    expect(unsafeRegexReason("(?<x>a)\\k<x>")).toBe("backreference");
    expect(unsafeRegexReason("a".repeat(SAFE_REGEX_MAX_PATTERN + 1))).toBe("pattern_too_long");
    expect(unsafeRegexReason("(a")).toBe("invalid");
    expect(unsafeRegexReason("a)")).toBe("invalid");
  });
});

describe("safeRegex", () => {
  test("matches like RegExp and honours flags", () => {
    expect(safeRegex("^abc$", "i").test("ABC")).toBe(true);
    expect(safeRegex("^abc$").test("ABC")).toBe(false);
  });

  test("ignores stateful flags so repeated tests agree", () => {
    const re = safeRegex("a", "g");
    expect(re.test("a")).toBe(true);
    expect(re.test("a")).toBe(true);
  });

  test("caps the input it reads", () => {
    const re = safeRegex("b$");
    expect(re.test(`${"a".repeat(SAFE_REGEX_MAX_INPUT)}b`)).toBe(false);
    expect(re.test("ab")).toBe(true);
  });

  test("a refusal carries the code, the reason and a remedy", () => {
    const error = (() => {
      try {
        safeRegex("(a+)+$");
      } catch (caught) {
        return caught;
      }
      return null;
    })();
    expect(error).toBeInstanceOf(UnsafeRegexError);
    const refusal = error as UnsafeRegexError;
    expect(refusal.code).toBe("regex_unsafe");
    expect(refusal.reason).toBe("nested_quantifier");
    expect(refusal.remedy).toContain("character class");
  });

  test("an unparsable pattern is refused as invalid", () => {
    expect(() => safeRegex("[a-")).toThrow(UnsafeRegexError);
    expect(isSafeRegex("[a-")).toBe(false);
    expect(isSafeRegex("^ok$")).toBe(true);
  });
});
