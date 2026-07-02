// Binary parser unit tests.
//
// Exercises each strategy (PDF / DOCX / XLSX / PPTX) against an
// in-memory fixture and the negative paths (wrong magic, malformed
// archive). Fixtures live in `fixtures.test-helper.ts` so the suite
// stays portable — no binary blobs in the repo.

import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import {
  buildDocxFixture,
  buildPdfFixture,
  buildPdfTableFixture,
  buildPptxFixture,
  buildXlsxFixture,
  buildZipFixture,
} from "../../test-helpers/binary-fixtures.ts";
import { BinaryParseError, detectBinaryFormat, parseBinaryFile } from "./index.ts";

describe("binary parsers: detection", () => {
  test("pdf magic bytes match", async () => {
    const pdf = buildPdfFixture("Hello.");
    expect(await detectBinaryFormat(pdf)).toBe("pdf");
  });

  test("docx detected via word/ prefix in zip directory", async () => {
    const docx = await buildDocxFixture("Title", "Body");
    expect(await detectBinaryFormat(docx)).toBe("docx");
  });

  test("xlsx detected via xl/ prefix in zip directory", async () => {
    const xlsx = buildXlsxFixture({ Sheet1: [{ a: 1 }] });
    expect(await detectBinaryFormat(xlsx)).toBe("xlsx");
  });

  test("pptx detected via ppt/ prefix in zip directory", async () => {
    const pptx = await buildPptxFixture(["one"]);
    expect(await detectBinaryFormat(pptx)).toBe("pptx");
  });

  test("plain UTF-8 text returns null", async () => {
    expect(await detectBinaryFormat(Buffer.from("just text"))).toBe(null);
  });
});

describe("binary parsers: parse", () => {
  test("pdf returns text and page count", async () => {
    const pdf = buildPdfFixture("Hello PDF world.");
    const result = await parseBinaryFile(pdf, "pdf");
    expect(result.format).toBe("pdf");
    if (result.format !== "pdf") throw new Error("unreachable");
    expect(result.pages).toBeGreaterThanOrEqual(1);
    expect(result.text).toContain("Hello PDF world");
  });

  test("docx returns markdown with the heading text", async () => {
    const docx = await buildDocxFixture("My Heading", "First paragraph.");
    const result = await parseBinaryFile(docx, "docx");
    expect(result.format).toBe("docx");
    if (result.format !== "docx") throw new Error("unreachable");
    expect(result.markdown).toMatch(/My Heading/);
    expect(result.markdown).toMatch(/First paragraph/);
  });

  test("xlsx returns sheets with rows", async () => {
    const xlsx = buildXlsxFixture({
      Sheet1: [
        { id: 1, name: "alice" },
        { id: 2, name: "bob" },
      ],
    });
    const result = await parseBinaryFile(xlsx, "xlsx");
    expect(result.format).toBe("xlsx");
    if (result.format !== "xlsx" && result.format !== "xls") throw new Error("unreachable");
    expect(Object.keys(result.sheets)).toContain("Sheet1");
    expect(result.sheets.Sheet1?.length).toBe(2);
    expect(result.sheets.Sheet1?.[0]).toMatchObject({ name: "alice" });
  });

  test("pptx returns one slide per slide entry", async () => {
    const pptx = await buildPptxFixture(["First", "Second", "Third"]);
    const result = await parseBinaryFile(pptx, "pptx");
    expect(result.format).toBe("pptx");
    if (result.format !== "pptx") throw new Error("unreachable");
    expect(result.slides.length).toBe(3);
    expect(result.slides[0]?.text).toContain("First");
    expect(result.slides[1]?.text).toContain("Second");
  });

  test("pdf with invalid header throws BinaryParseError", async () => {
    await expect(parseBinaryFile(Buffer.from("not a pdf"), "pdf")).rejects.toBeInstanceOf(
      BinaryParseError,
    );
  });

  test("docx with malformed zip throws BinaryParseError", async () => {
    await expect(
      parseBinaryFile(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff]), "docx"),
    ).rejects.toBeInstanceOf(BinaryParseError);
  });

  test("pptx with an oversized single slide throws BinaryParseError", async () => {
    // One slide whose `<a:t>` body is ~3 MB — over the 2 MB
    // PPTX_SLIDE_XML_MAX_BYTES per-slide ceiling. The parser must
    // abort the read instead of allocating the whole string.
    const hugeSlide = "x".repeat(3 * 1024 * 1024);
    const pptx = await buildPptxFixture([hugeSlide]);
    await expect(parseBinaryFile(pptx, "pptx")).rejects.toBeInstanceOf(BinaryParseError);
  });
});

describe("archive strategies: detection", () => {
  test("plain zip detects as zip (not an office format)", async () => {
    const zip = buildZipFixture([{ name: "notes.txt", data: "hello" }]);
    expect(await detectBinaryFormat(zip)).toBe("zip");
  });

  test("gzip magic detects as gzip", async () => {
    expect(await detectBinaryFormat(gzipSync(Buffer.from("hello")))).toBe("gzip");
  });

  test("office formats still win over the generic zip detector (priority regression)", async () => {
    const docx = await buildDocxFixture("Title", "Body");
    const xlsx = buildXlsxFixture({ Sheet1: [{ a: 1 }] });
    const pptx = await buildPptxFixture(["Slide one"]);
    expect(await detectBinaryFormat(docx)).toBe("docx");
    expect(await detectBinaryFormat(xlsx)).toBe("xlsx");
    expect(await detectBinaryFormat(pptx)).toBe("pptx");
  });
});

describe("archive strategies: recursive extraction", () => {
  test("zip with pdf + csv + docx extracts every member under ## headers", async () => {
    const pdf = buildPdfFixture("PDF inside an archive.");
    const docx = await buildDocxFixture("Inner Doc", "Docx body inside an archive.");
    const zip = buildZipFixture([
      { name: "docs/report.pdf", data: pdf },
      { name: "data/rows.csv", data: "id,name\n1,alpha\n2,beta" },
      { name: "docs/spec.docx", data: docx },
    ]);
    const parsed = await parseBinaryFile(zip, "zip");
    expect(parsed.format).toBe("zip");
    expect(parsed.entries.map((e) => e.path).sort()).toEqual([
      "data/rows.csv",
      "docs/report.pdf",
      "docs/spec.docx",
    ]);
    expect(parsed.entries.find((e) => e.path === "docs/report.pdf")?.format).toBe("pdf");
    expect(parsed.entries.find((e) => e.path === "data/rows.csv")?.format).toBe("text");
    expect(parsed.entries.find((e) => e.path === "docs/spec.docx")?.format).toBe("docx");
    expect(parsed.text).toContain("## docs/report.pdf");
    expect(parsed.text).toContain("PDF inside an archive.");
    expect(parsed.text).toContain("## data/rows.csv");
    expect(parsed.text).toContain("1,alpha");
    expect(parsed.text).toContain("Docx body inside an archive.");
    expect(parsed.skipped).toEqual([]);
  });

  test("gzip of a csv extracts as text", async () => {
    const gz = gzipSync(Buffer.from("id,name\n1,alpha"));
    const parsed = await parseBinaryFile(gz, "gzip");
    expect(parsed.format).toBe("gzip");
    expect(parsed.entries).toEqual([{ path: "content", format: "text" }]);
    expect(parsed.text).toContain("1,alpha");
  });

  test("gzip(zip(pdf)) extracts at depth 2; a third archive level is skipped", async () => {
    const pdf = buildPdfFixture("Deeply nested.");
    const innerZip = buildZipFixture([{ name: "too-deep.pdf", data: pdf }]);
    const midZip = buildZipFixture([
      { name: "keep.pdf", data: pdf },
      { name: "nested.zip", data: innerZip },
    ]);
    const gz = gzipSync(midZip);
    const parsed = await parseBinaryFile(gz, "gzip");
    // keep.pdf lives at level 2 (gzip -> zip) and extracts.
    expect(parsed.text).toContain("Deeply nested.");
    expect(parsed.entries.some((e) => e.path.endsWith("keep.pdf"))).toBe(true);
    // nested.zip would be level 3 — refused with a reason.
    expect(parsed.skipped.some((s) => s.reason === "nested_archive_depth")).toBe(true);
    expect(parsed.entries.some((e) => e.path.includes("too-deep"))).toBe(false);
  });

  test("macOS metadata entries are skipped, undecodable binaries reported", async () => {
    const zip = buildZipFixture([
      { name: "__MACOSX/._junk", data: "resource fork" },
      { name: ".DS_Store", data: Buffer.from([0x00, 0x01, 0x02]) },
      { name: "blob.bin", data: Buffer.from([0xff, 0xfe, 0x00, 0x80]) },
      { name: "keep.txt", data: "kept" },
    ]);
    const parsed = await parseBinaryFile(zip, "zip");
    expect(parsed.entries).toEqual([{ path: "keep.txt", format: "text" }]);
    const reasons = parsed.skipped.map((s) => s.reason).sort();
    expect(reasons).toEqual(["macos_metadata", "os_metadata", "undecodable_binary"]);
  });

  test("entry-count cap truncates the walk with a reason", async () => {
    const { ARCHIVE_MAX_ENTRIES } = await import("./archive.ts");
    const entries = Array.from({ length: ARCHIVE_MAX_ENTRIES + 1 }, (_, i) => ({
      name: `f${i}.txt`,
      data: `body ${i}`,
    }));
    const parsed = await parseBinaryFile(buildZipFixture(entries), "zip");
    expect(parsed.entries.length).toBeLessThanOrEqual(ARCHIVE_MAX_ENTRIES);
    expect(parsed.skipped.some((s) => s.reason === "truncated_by_caps")).toBe(true);
  });

  test("malformed zip throws BinaryParseError", async () => {
    const junk = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from("this is not a real archive"),
    ]);
    await expect(parseBinaryFile(junk, "zip")).rejects.toBeInstanceOf(BinaryParseError);
  });

  test("corrupt member degrades to a skip instead of failing the archive", async () => {
    // %PDF magic but garbage body — detected as pdf, parse fails.
    const fakePdf = Buffer.from("%PDF-1.7 not really a pdf");
    const zip = buildZipFixture([
      { name: "broken.pdf", data: fakePdf },
      { name: "fine.txt", data: "still extracted" },
    ]);
    const parsed = await parseBinaryFile(zip, "zip");
    expect(parsed.text).toContain("still extracted");
    expect(
      parsed.skipped.some((s) => s.path === "broken.pdf" && s.reason.startsWith("parse_failed")),
    ).toBe(true);
  });
});

describe("pdf table extraction", () => {
  test("ruled table renders as a markdown table appended to the page text", async () => {
    const pdf = buildPdfTableFixture([
      ["Name", "Amount", "Status"],
      ["Alpha", "100", "paid"],
      ["Beta", "250", "open"],
    ]);
    const parsed = await parseBinaryFile(pdf, "pdf");
    expect(parsed.format).toBe("pdf");
    // Structured table data surfaced for consumers that want it…
    expect(parsed.tables).toEqual([
      {
        page: 1,
        tables: [
          [
            ["Name", "Amount", "Status"],
            ["Alpha", "100", "paid"],
            ["Beta", "250", "open"],
          ],
        ],
      },
    ]);
    // …and the rendered text carries the markdown table so every text
    // consumer (knowledge chunking, LLM text_extract) benefits.
    expect(parsed.text).toContain("| Name | Amount | Status |");
    expect(parsed.text).toContain("| Alpha | 100 | paid |");
  });

  test("pdf without tables keeps plain text and an empty tables array", async () => {
    const pdf = buildPdfFixture("Just prose, no grid.");
    const parsed = await parseBinaryFile(pdf, "pdf");
    expect(parsed.tables).toEqual([]);
    expect(parsed.text).toContain("Just prose, no grid.");
    expect(parsed.text).not.toContain("| --- |");
  });
});
