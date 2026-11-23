import { describe, expect, test } from "bun:test";
import { buildXlsxFixture } from "../../test-helpers/binary-fixtures.ts";
import { packTable, parseTable, unpackTable } from "./table.ts";
import { parseXlsxTable } from "./xlsx.ts";

const encode = (text: string) => Buffer.from(text, "utf-8");

function sheetRows(count: number) {
  return Array.from({ length: count }, (_, i) => ({ id: i + 1, name: `row ${i + 1}` }));
}

describe("parseXlsxTable", () => {
  const workbook = buildXlsxFixture({ Summary: [{ a: 1 }], Detail: sheetRows(250) });

  test("the first sheet is the default and every sheet name is listed", () => {
    expect(parseXlsxTable(workbook, { max_rows: 10 })).toEqual({
      ok: true,
      sheet: "Summary",
      sheets: ["Summary", "Detail"],
      rows: [{ a: 1 }],
      row_count: 1,
      truncated: false,
    });
  });

  test("a sheet longer than max_rows is cut and reports its real row count", () => {
    const result = parseXlsxTable(workbook, { sheet: "Detail", max_rows: 200 });
    expect(result).toMatchObject({ ok: true, sheet: "Detail", row_count: 250, truncated: true });
    if (!result.ok) return;
    expect(result.rows).toHaveLength(200);
    expect(result.rows[199]).toEqual({ id: 200, name: "row 200" });
  });

  test("a sheet within max_rows is returned whole", () => {
    const result = parseXlsxTable(workbook, { sheet: "Detail", max_rows: 10_000 });
    expect(result).toMatchObject({ ok: true, row_count: 250, truncated: false });
    if (result.ok) expect(result.rows).toHaveLength(250);
  });

  test("an unknown sheet names the sheets that exist", () => {
    expect(parseXlsxTable(workbook, { sheet: "Nope", max_rows: 10 })).toEqual({
      ok: false,
      sheets: ["Summary", "Detail"],
    });
  });

  test("an empty sheet has no rows", () => {
    expect(parseXlsxTable(buildXlsxFixture({ Empty: [] }), { max_rows: 10 })).toEqual({
      ok: true,
      sheet: "Empty",
      sheets: ["Empty"],
      rows: [],
      row_count: 0,
      truncated: false,
    });
  });
});

describe("parseTable", () => {
  test("a CSV becomes a table", () => {
    expect(parseTable(encode("a;b\n1;2\n3;4\n"), { format: "csv", max_rows: 1 })).toEqual({
      ok: true,
      format: "csv",
      rows: [{ a: "1", b: "2" }],
      row_count: 2,
      truncated: true,
    });
  });

  test("a malformed CSV says why", () => {
    const result = parseTable(encode("a,b\n1\n"), { format: "csv", max_rows: 5 });
    expect(result).toMatchObject({ ok: false, reason: "malformed" });
  });

  test("a spreadsheet becomes a table of one sheet", () => {
    const result = parseTable(buildXlsxFixture({ One: [{ a: 1 }] }), {
      format: "xlsx",
      max_rows: 5,
    });
    expect(result).toEqual({
      ok: true,
      format: "xlsx",
      sheet: "One",
      sheets: ["One"],
      rows: [{ a: 1 }],
      row_count: 1,
      truncated: false,
    });
  });

  test("a missing sheet says which sheets exist", () => {
    const result = parseTable(buildXlsxFixture({ One: [{ a: 1 }] }), {
      format: "xlsx",
      max_rows: 5,
      sheet: "Two",
    });
    expect(result).toEqual({ ok: false, reason: "sheet_missing", sheets: ["One"] });
  });
});

describe("packed tables", () => {
  test("rows survive the round trip without repeating keys per row", () => {
    const table = {
      ok: true as const,
      format: "xlsx" as const,
      sheet: "S",
      sheets: ["S"],
      rows: [{ a: 1, b: "x" }, { a: 2 }],
      row_count: 2,
      truncated: false,
    };
    const packed = packTable(table);
    expect(packed).toEqual({
      ok: true,
      format: "xlsx",
      sheet: "S",
      sheets: ["S"],
      fields: ["a", "b"],
      rows_json: '[[1,"x"],[2,null]]',
      row_count: 2,
      truncated: false,
    });
    expect(unpackTable(packed)).toEqual({
      ...table,
      rows: [
        { a: 1, b: "x" },
        { a: 2, b: null },
      ],
    });
  });

  test("failures pass through unchanged", () => {
    const failure = { ok: false as const, reason: "sheet_missing" as const, sheets: ["A"] };
    expect(unpackTable(packTable(failure))).toEqual(failure);
  });
});
