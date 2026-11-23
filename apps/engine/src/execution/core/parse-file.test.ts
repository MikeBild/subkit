import { describe, expect, test } from "bun:test";
import {
  PARSE_FILE_FAILED,
  PARSE_FILE_MAX_BYTES,
  PARSE_FILE_SHEET_MISSING,
  PARSE_FILE_SOURCE_MISSING,
  PARSE_FILE_TOO_LARGE,
  PARSE_FILE_UNSUPPORTED_FORMAT,
  parseFileCsvFailure,
  parseFileFormat,
  parseFileOutput,
  parseFileRowLimit,
  parseFileSizeRefusal,
  parseFileSource,
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

  test("the first sheet is the default and an unknown sheet is refused", () => {
    const parsed = { format: "xlsx" as const, sheets: { One: [{ a: 1 }], Two: [] } };
    expect(parseFileOutput(parsed, { filename: "s.xlsx" })).toMatchObject({
      ok: true,
      value: { sheet: "One", sheets: ["One", "Two"], rows: [{ a: 1 }] },
    });
    const missing = parseFileOutput(parsed, { filename: "s.xlsx", sheet: "Three" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.failure.code).toBe(PARSE_FILE_SHEET_MISSING);
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
  });
});

describe("parse-file row limit", () => {
  test("max_rows wins and the default is 10,000", () => {
    expect(parseFileRowLimit(5)).toBe(5);
    expect(parseFileRowLimit(undefined)).toBe(10_000);
  });
});

describe("parse-file csv failure", () => {
  test("a malformed CSV fails with its parser errors as details", () => {
    const errors = [{ code: "MissingQuotes", row: 2, message: "Quoted field unterminated" }];
    expect(parseFileCsvFailure({ message: "The CSV file is malformed.", errors })).toEqual({
      code: PARSE_FILE_FAILED,
      message: "The CSV file is malformed.",
      details: { errors },
    });
  });
});
