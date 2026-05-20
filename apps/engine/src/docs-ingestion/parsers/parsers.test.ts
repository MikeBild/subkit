// Binary parser unit tests.
//
// Exercises each strategy (PDF / DOCX / XLSX / PPTX) against an
// in-memory fixture and the negative paths (wrong magic, malformed
// archive). Fixtures live in `fixtures.test-helper.ts` so the suite
// stays portable — no binary blobs in the repo.

import { describe, expect, test } from "bun:test";
import {
  buildDocxFixture,
  buildPdfFixture,
  buildPptxFixture,
  buildXlsxFixture,
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
