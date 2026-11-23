import { describe, expect, test } from "bun:test";
import { parseCsvRows } from "./csv.ts";

const encode = (text: string) => new TextEncoder().encode(text);

function numberedCsv(rows: number): Uint8Array {
  const lines = ["id,name"];
  for (let i = 1; i <= rows; i += 1) lines.push(`${i},row ${i}`);
  return encode(`${lines.join("\n")}\n`);
}

describe("parseCsvRows", () => {
  test("rows are keyed by the header and empty lines are skipped", () => {
    expect(parseCsvRows(encode("id,total\n1,10\n\n , \n2,20\n"), { max_rows: 10 })).toEqual({
      ok: true,
      rows: [
        { id: "1", total: "10" },
        { id: "2", total: "20" },
      ],
      row_count: 2,
      truncated: false,
    });
  });

  test("rows past max_rows are counted but not kept", () => {
    const result = parseCsvRows(numberedCsv(20_000), { max_rows: 10_000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(10_000);
    expect(result.rows[9_999]).toEqual({ id: "10000", name: "row 10000" });
    expect(result.row_count).toBe(20_000);
    expect(result.truncated).toBe(true);
  });

  test("exactly max_rows rows are not truncated", () => {
    const result = parseCsvRows(numberedCsv(3), { max_rows: 3 });
    expect(result).toMatchObject({ ok: true, row_count: 3, truncated: false });
  });

  test("a byte order mark does not leak into the first header", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...encode("id,name\n1,Ada\n")]);
    expect(parseCsvRows(bytes, { max_rows: 5 })).toMatchObject({
      ok: true,
      rows: [{ id: "1", name: "Ada" }],
    });
  });

  test("quoted fields keep commas, quotes and line breaks", () => {
    const result = parseCsvRows(encode('id,note\n1,"a, b"\n2,"say ""hi"""\n3,"two\nlines"\n'), {
      max_rows: 10,
    });
    expect(result).toEqual({
      ok: true,
      rows: [
        { id: "1", note: "a, b" },
        { id: "2", note: 'say "hi"' },
        { id: "3", note: "two\nlines" },
      ],
      row_count: 3,
      truncated: false,
    });
  });

  test("an unclosed quote is reported as malformed", () => {
    const result = parseCsvRows(encode('id,note\n1,"open\n2,x\n'), { max_rows: 10 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toStartWith("The CSV file is malformed:");
    expect(result.errors[0]?.code).toBe("MissingQuotes");
  });

  test("rows with the wrong number of fields are reported with their row", () => {
    const result = parseCsvRows(encode("a,b\n1,2\n3\n4,5,6\n"), { max_rows: 10 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([
      expect.objectContaining({ code: "TooFewFields", row: 2 }),
      expect.objectContaining({ code: "TooManyFields", row: 3 }),
    ]);
    expect(result.message).toContain("(row 2)");
  });

  test("at most five errors are reported", () => {
    const result = parseCsvRows(encode(`a,b\n${"1\n".repeat(50)}`), { max_rows: 100 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(5);
  });

  test("an empty file has no rows", () => {
    expect(parseCsvRows(encode(""), { max_rows: 5 })).toEqual({
      ok: true,
      rows: [],
      row_count: 0,
      truncated: false,
    });
  });

  test("inputs above one megabyte parse", () => {
    const filler = "x".repeat(200);
    const lines = ["id,text"];
    for (let i = 0; i < 8_000; i += 1) lines.push(`${i},${filler}`);
    const bytes = encode(lines.join("\n"));
    expect(bytes.byteLength).toBeGreaterThan(1024 * 1024);
    const result = parseCsvRows(bytes, { max_rows: 10_000 });
    expect(result).toMatchObject({ ok: true, row_count: 8_000, truncated: false });
  });

  test("wide rows keep every column", () => {
    const columns = Array.from({ length: 1_000 }, (_, i) => `c${i}`);
    const lines = [columns.join(",")];
    for (let r = 0; r < 200; r += 1) lines.push(columns.map((_, c) => `${r}-${c}`).join(","));
    const result = parseCsvRows(encode(lines.join("\n")), { max_rows: 10_000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(200);
    expect(Object.keys(result.rows[199] ?? {})).toHaveLength(1_000);
    expect(result.rows[199]?.c999).toBe("199-999");
  });
});
