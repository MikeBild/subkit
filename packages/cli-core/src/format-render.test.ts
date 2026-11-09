import { describe, expect, test } from "bun:test";
import { renderTable, stringifyCell, toJson } from "./format-render.ts";

describe("pure CLI rendering", () => {
  test("renders JSON with the established two-space layout", () => {
    expect(toJson({ name: "A", enabled: true })).toBe('{\n  "name": "A",\n  "enabled": true\n}');
    expect(toJson(null)).toBe("null");
    expect(toJson(undefined)).toBeUndefined();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => toJson(circular)).toThrow();
  });

  test("renders cell primitives and explicit dates without ambient time", () => {
    const cases: [unknown, string][] = [
      [null, ""],
      [undefined, ""],
      ["", ""],
      ["plain", "plain"],
      [0, "0"],
      [-2, "-2"],
      [1.5, "1.5"],
      [Number.NaN, "NaN"],
      [Number.POSITIVE_INFINITY, "Infinity"],
      [Number.NEGATIVE_INFINITY, "-Infinity"],
      [true, "true"],
      [false, "false"],
      [new Date("2024-01-02T03:04:05Z"), "2024-01-02T03:04:05.000Z"],
      [{ key: "value" }, '{"key":"value"}'],
      [[1, "two"], '[1,"two"]'],
    ];
    for (const [value, rendered] of cases) expect(stringifyCell(value)).toBe(rendered);
    expect(() => stringifyCell(new Date("invalid"))).toThrow();
  });

  test("falls back for non-JSON values while preserving undefined JSON results", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(stringifyCell(circular)).toBe("[object Object]");
    expect(stringifyCell(12n)).toBe("12");
    expect(stringifyCell(Symbol("value"))).toBeUndefined();
    expect(stringifyCell(() => "value")).toBeUndefined();
  });

  test("renders requested column and row order, missing cells and empty tables", () => {
    expect(renderTable(["id"], [])).toBe("");
    const rows = [
      { id: 2, name: "B" },
      { id: 1, name: "A" },
    ];
    const before = structuredClone(rows);
    expect(renderTable(["name", "id", "missing"], rows)).toBe("name\tid\tmissing\nB\t2\t\nA\t1\t");
    expect(rows).toEqual(before);
    expect(renderTable([], [{}])).toBe("\n");
  });
});
