import { describe, expect, test } from "bun:test";
import { pageFingerprint, repeatVerdict, stopWhenVerdict } from "./pagination-guard.ts";

describe("pageFingerprint", () => {
  test("ignores key order at every depth", () => {
    expect(pageFingerprint({ a: 1, b: { c: [1, { x: 1, y: 2 }], d: null } })).toBe(
      pageFingerprint({ b: { d: null, c: [1, { y: 2, x: 1 }] }, a: 1 }),
    );
  });

  test("keeps array order significant", () => {
    expect(pageFingerprint([1, 2])).not.toBe(pageFingerprint([2, 1]));
  });

  test("separates different pages", () => {
    expect(pageFingerprint({ items: [{ id: 1 }] })).not.toBe(
      pageFingerprint({ items: [{ id: 2 }] }),
    );
  });

  test("handles bodies that are not objects", () => {
    expect(pageFingerprint("page")).toBe(pageFingerprint("page"));
    expect(pageFingerprint(null)).not.toBe(pageFingerprint(undefined));
    expect(pageFingerprint(undefined)).toHaveLength(64);
  });
});

describe("repeatVerdict", () => {
  test("a first page is new", () => {
    expect(repeatVerdict(new Set(), pageFingerprint({ page: 1 }))).toBe("new");
  });

  test("the same page again is repeated", () => {
    const seen = new Set([pageFingerprint({ page: 1 })]);
    expect(repeatVerdict(seen, pageFingerprint({ page: 1 }))).toBe("repeated");
    expect(repeatVerdict(seen, pageFingerprint({ page: 2 }))).toBe("new");
  });

  test("judges a repeated cursor the same way", () => {
    expect(repeatVerdict(new Set(["cursor-a"]), "cursor-a")).toBe("repeated");
  });
});

describe("stopWhenVerdict", () => {
  test("true stops and false continues", () => {
    expect(stopWhenVerdict(true)).toBe("stop");
    expect(stopWhenVerdict(false)).toBe("continue");
  });

  test("anything else is not an answer", () => {
    for (const value of [1, 0, "true", null, undefined, {}, []])
      expect(stopWhenVerdict(value)).toBe("invalid");
  });
});
