// Type-guard smoke tests. The guards are tiny one-liners but their
// type-narrowing semantics matter — `isRecord` rejects arrays + null,
// for instance, which a naive `typeof === "object"` check accepts.

import { describe, expect, test } from "bun:test";

import { isRecord } from "../type-guards.ts";

describe("isRecord", () => {
  test("accepts plain objects", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
  });

  test("rejects arrays", () => {
    expect(isRecord([])).toBe(false);
    expect(isRecord([1, 2])).toBe(false);
  });

  test("rejects primitives + null", () => {
    expect(isRecord(null)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord("string")).toBe(false);
    expect(isRecord(42)).toBe(false);
    expect(isRecord(true)).toBe(false);
  });
});
