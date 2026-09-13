// Pure-function tests for the safe-json wrapper. The implementation
// falls back to `jsonrepair` when raw JSON.parse fails — the most
// common LLM failure mode (trailing commas, missing quotes, smart
// quotes, unescaped newlines).

import { describe, expect, test } from "bun:test";

import { safeParseJson, safeParseJsonWithMeta } from "../safe-json.ts";

describe("safeParseJson", () => {
  test("parses well-formed JSON", () => {
    expect(safeParseJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });

  test("repairs trailing commas", () => {
    expect(safeParseJson<{ a: number }>('{"a":1,}')).toEqual({ a: 1 });
  });

  test("repairs missing quotes on keys", () => {
    expect(safeParseJson<{ a: number }>("{a:1}")).toEqual({ a: 1 });
  });

  test("returns undefined for empty input", () => {
    expect(safeParseJson("")).toBeUndefined();
  });

  test("repairs garbage to a string literal (jsonrepair behavior)", () => {
    // jsonrepair is intentionally aggressive — it coerces unrecognised
    // input into a JSON string rather than refusing. Callers that want
    // strict parsing should use `safeParseJsonWithMeta` and check
    // `repaired === false`.
    const out = safeParseJson<string>("not json at all");
    expect(out).toBe("not json at all");
  });
});

describe("safeParseJsonWithMeta", () => {
  test("flags raw-parse path", () => {
    const r = safeParseJsonWithMeta<{ a: number }>('{"a":1}');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ a: 1 });
      expect(r.repaired).toBe(false);
    }
  });

  test("flags repaired path", () => {
    const r = safeParseJsonWithMeta<{ a: number }>('{"a":1,}');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ a: 1 });
      expect(r.repaired).toBe(true);
    }
  });

  test("returns ok:false only for empty input", () => {
    expect(safeParseJsonWithMeta("")).toEqual({ ok: false });
  });

  test("repaired path even for garbage (string-coercion fallback)", () => {
    const r = safeParseJsonWithMeta<string>("xx");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.repaired).toBe(true);
      expect(r.value).toBe("xx");
    }
  });
});
