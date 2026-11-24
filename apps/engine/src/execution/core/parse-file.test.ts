import { describe, expect, test } from "bun:test";
import {
  PARSE_FILE_FAILED,
  PARSE_FILE_MAX_BYTES,
  PARSE_FILE_SHEET_MISSING,
  PARSE_FILE_SOURCE_MISSING,
  PARSE_FILE_TOO_LARGE,
  PARSE_FILE_UNSUPPORTED_FORMAT,
  parseFileFormat,
  parseFileOutput,
  parseFileRowLimit,
  parseFileSizeRefusal,
  parseFileSource,
  parseFileTable,
} from "./parse-file.ts";

describe("parse-file source", () => {
  test("reads a bare reference, a request file result and a run input", () => {
    const scope = {
      download: { data: { file: { $file: "fid_a" }, filename: "a.pdf" } },
      attach: { data: { $file: "fid_b" } },
      $input: { doc: { $file: "fid_c" } },
    };
    expect(parseFileSource(scope, "download.data")).toEqual({ ok: true, value: "fid_a" });
    expect(parseFileSource(scope, "attach.data")).toEqual({ ok: true, value: "fid_b" });
    expect(parseFileSource(scope, "$input.doc")).toEqual({ ok: true, value: "fid_c" });
  });

  test("anything else names the missing source", () => {
    const missing = parseFileSource({ x: { data: "text" } }, "x.data");
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.failure.code).toBe(PARSE_FILE_SOURCE_MISSING);
  });
});

describe("parse-file format", () => {
  const base = { declared: undefined, filename: "f", content_type: null, detected: null };

  test("a declared format wins, CSV comes from the name or type, the rest from the bytes", () => {
    expect(parseFileFormat({ ...base, declared: "zip", detected: "pdf" })).toEqual({
      ok: true,
      value: "zip",
    });
    expect(parseFileFormat({ ...base, filename: "a.CSV" })).toEqual({ ok: true, value: "csv" });
    expect(parseFileFormat({ ...base, content_type: "text/csv; charset=utf-8" })).toEqual({
      ok: true,
      value: "csv",
    });
    expect(parseFileFormat({ ...base, detected: "xlsx" })).toEqual({ ok: true, value: "xlsx" });
  });

  test("formats outside the list are refused", () => {
    for (const detected of ["pptx", "xls", "gzip", null]) {
      const decision = parseFileFormat({ ...base, detected });
      expect(decision.ok).toBe(false);
      if (!decision.ok) expect(decision.failure.code).toBe(PARSE_FILE_UNSUPPORTED_FORMAT);
    }
  });
});

describe("parse-file size", () => {
  test("files above the cap are refused", () => {
    expect(parseFileSizeRefusal(PARSE_FILE_MAX_BYTES)).toBeNull();
    expect(parseFileSizeRefusal(PARSE_FILE_MAX_BYTES + 1)?.code).toBe(PARSE_FILE_TOO_LARGE);
  });
});

describe("parse-file output", () => {
  test("table rows are bounded and say when they were cut", () => {
    const out = parseFileOutput(
      { format: "csv", rows: [{ a: 1 }, { a: 2 }, { a: 3 }], row_count: 3, truncated: false },
      { filename: "a.csv", max_rows: 2 },
    );
    expect(out).toEqual({
      ok: true,
      value: {
        format: "csv",
        filename: "a.csv",
        rows: [{ a: 1 }, { a: 2 }],
        row_count: 3,
        truncated: true,
      },
    });
  });

  test("a CSV cut by the parser keeps the full row count", () => {
    const out = parseFileOutput(
      { format: "csv", rows: [{ a: 1 }, { a: 2 }], row_count: 20_000, truncated: true },
      { filename: "big.csv", max_rows: 2 },
    );
    expect(out).toEqual({
      ok: true,
      value: {
        format: "csv",
        filename: "big.csv",
        rows: [{ a: 1 }, { a: 2 }],
        row_count: 20_000,
        truncated: true,
      },
    });
  });

  test("a spreadsheet keeps its sheet names and is bounded like a CSV", () => {
    const parsed = {
      format: "xlsx" as const,
      sheet: "One",
      sheets: ["One", "Two"],
      rows: [{ a: 1 }, { a: 2 }],
      row_count: 300,
      truncated: true,
    };
    expect(parseFileOutput(parsed, { filename: "s.xlsx", max_rows: 1 })).toEqual({
      ok: true,
      value: {
        format: "xlsx",
        filename: "s.xlsx",
        sheet: "One",
        sheets: ["One", "Two"],
        rows: [{ a: 1 }],
        row_count: 300,
        truncated: true,
      },
    });
  });

  test("documents become text", () => {
    expect(parseFileOutput({ format: "docx", markdown: "# Hi" }, { filename: "d.docx" })).toEqual({
      ok: true,
      value: { format: "docx", filename: "d.docx", text: "# Hi" },
    });
    expect(parseFileOutput({ format: "pdf", text: "x", pages: 2 }, { filename: "p.pdf" })).toEqual({
      ok: true,
      value: { format: "pdf", filename: "p.pdf", text: "x", pages: 2 },
    });
    const entries = [{ path: "a.csv", format: "csv" }];
    const skipped = [{ path: "b.bin", reason: "unsupported" }];
    expect(
      parseFileOutput({ format: "zip", text: "a", entries, skipped }, { filename: "z.zip" }),
    ).toEqual({
      ok: true,
      value: { format: "zip", filename: "z.zip", text: "a", entries, skipped },
    });
  });
});

describe("parse-file row limit", () => {
  test("max_rows wins and the default is 10,000", () => {
    expect(parseFileRowLimit(5)).toBe(5);
    expect(parseFileRowLimit(undefined)).toBe(10_000);
  });
});

describe("parse-file table", () => {
  test("a parsed CSV or spreadsheet becomes a parsed file", () => {
    expect(
      parseFileTable(
        { ok: true, format: "csv", rows: [], row_count: 0, truncated: false },
        undefined,
      ),
    ).toEqual({
      ok: true,
      value: { format: "csv", rows: [], row_count: 0, truncated: false },
    });
    expect(
      parseFileTable(
        {
          ok: true,
          format: "xlsx",
          sheet: "S",
          sheets: ["S"],
          rows: [{ a: 1 }],
          row_count: 1,
          truncated: false,
        },
        "S",
      ),
    ).toEqual({
      ok: true,
      value: {
        format: "xlsx",
        sheet: "S",
        sheets: ["S"],
        rows: [{ a: 1 }],
        row_count: 1,
        truncated: false,
      },
    });
    expect(
      parseFileTable(
        { ok: true, format: "xlsx", rows: [], row_count: 0, truncated: false },
        undefined,
      ),
    ).toMatchObject({ ok: true, value: { sheet: "", sheets: [] } });
  });

  test("a malformed CSV fails with its parser errors as details", () => {
    const errors = [{ code: "MissingQuotes", row: 2, message: "Quoted field unterminated" }];
    expect(
      parseFileTable(
        { ok: false, reason: "malformed", message: "The CSV file is malformed.", errors },
        undefined,
      ),
    ).toEqual({
      ok: false,
      failure: {
        code: PARSE_FILE_FAILED,
        message: "The CSV file is malformed.",
        details: { errors },
      },
    });
  });

  test("a missing sheet names the sheets that exist", () => {
    const missing = parseFileTable({ ok: false, reason: "sheet_missing", sheets: ["A"] }, "B");
    expect(missing).toEqual({
      ok: false,
      failure: {
        code: PARSE_FILE_SHEET_MISSING,
        message: 'The spreadsheet has no sheet named "B".',
        details: { sheets: ["A"] },
      },
    });
    const empty = parseFileTable({ ok: false, reason: "sheet_missing", sheets: [] }, undefined);
    if (!empty.ok) expect(empty.failure.message).toBe("The spreadsheet has no sheets.");
  });
});
