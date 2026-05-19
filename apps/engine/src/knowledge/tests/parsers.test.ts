import { describe, expect, test } from "bun:test";
import {
  buildDocxFixture,
  buildPdfFixture,
  buildXlsxFixture,
} from "../../docs-ingestion/parsers/fixtures.test-helper.ts";
import {
  detectFormat,
  isBinaryFormat,
  parseBinaryFileToChunks,
  parseFileToChunks,
} from "../parsers.ts";

describe("knowledge/parsers", () => {
  describe("detectFormat", () => {
    test("detects JSON by extension", () => {
      expect(detectFormat("config.json")).toBe("json");
    });
    test("detects YAML by extension", () => {
      expect(detectFormat("config.yaml")).toBe("yaml");
      expect(detectFormat("config.yml")).toBe("yaml");
    });
    test("detects CSV by extension", () => {
      expect(detectFormat("data.csv")).toBe("csv");
      expect(detectFormat("data.tsv")).toBe("csv");
    });
    test("detects XML by extension", () => {
      expect(detectFormat("schema.xml")).toBe("xml");
    });
    test("detects Markdown by extension", () => {
      expect(detectFormat("readme.md")).toBe("markdown");
      expect(detectFormat("guide.markdown")).toBe("markdown");
    });
    test("detects plaintext by extension", () => {
      expect(detectFormat("notes.txt")).toBe("plaintext");
      expect(detectFormat("output.log")).toBe("plaintext");
    });
    test("falls back to MIME type", () => {
      expect(detectFormat("file", "application/json")).toBe("json");
      expect(detectFormat("file", "text/csv")).toBe("csv");
      expect(detectFormat("file", "text/markdown")).toBe("markdown");
    });
    test("returns unknown for unrecognized", () => {
      expect(detectFormat("file.bin")).toBe("unknown");
      expect(detectFormat("file", "application/octet-stream")).toBe("unknown");
    });
    test("detects binary office formats by extension", () => {
      expect(detectFormat("report.pdf")).toBe("pdf");
      expect(detectFormat("doc.docx")).toBe("docx");
      expect(detectFormat("sheet.xlsx")).toBe("xlsx");
      expect(detectFormat("legacy.xls")).toBe("xls");
      expect(detectFormat("deck.pptx")).toBe("pptx");
      expect(isBinaryFormat("pdf")).toBe(true);
      expect(isBinaryFormat("markdown")).toBe(false);
    });
    test("detects binary office formats by MIME", () => {
      expect(detectFormat("noext", "application/pdf")).toBe("pdf");
      expect(
        detectFormat(
          "noext",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ),
      ).toBe("docx");
      expect(
        detectFormat("noext", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
      ).toBe("xlsx");
    });
  });

  describe("parseBinaryFileToChunks", () => {
    test("pdf produces per-page chunks", async () => {
      const pdf = buildPdfFixture("Page body text.");
      const chunks = await parseBinaryFileToChunks(pdf, "sample.pdf", "pdf");
      expect(chunks.length).toBeGreaterThanOrEqual(1);
      expect(chunks[0]?.content).toContain("Page body text");
    });
    test("docx is markdown-chunked via heading boundaries", async () => {
      const docx = await buildDocxFixture("Section A", "Body for A.");
      const chunks = await parseBinaryFileToChunks(docx, "sample.docx", "docx");
      expect(chunks.length).toBeGreaterThanOrEqual(1);
      const joined = chunks.map((c) => c.content).join("\n");
      expect(joined).toMatch(/Section A/);
    });
    test("xlsx produces one chunk per sheet", async () => {
      const xlsx = buildXlsxFixture({
        Demo: [
          { id: 1, name: "x" },
          { id: 2, name: "y" },
        ],
      });
      const chunks = await parseBinaryFileToChunks(xlsx, "sample.xlsx", "xlsx");
      expect(chunks.length).toBe(1);
      expect(chunks[0]?.path).toBe("sample.xlsx#sheet=Demo");
    });
    test("text-format returns empty when called on binary helper", async () => {
      const empty = await parseBinaryFileToChunks(Buffer.from("hello"), "x.json", "json");
      expect(empty).toEqual([]);
    });
  });

  describe("parseFileToChunks", () => {
    test("markdown splits on headings", () => {
      const content =
        "# Title\n\nIntro paragraph.\n\n## Section A\n\nContent A.\n\n## Section B\n\nContent B.";
      const chunks = parseFileToChunks(content, "doc.md", "markdown");
      expect(chunks.length).toBe(3);
      expect(chunks[0]!.title).toBe("Title");
      expect(chunks[1]!.title).toBe("Section A");
      expect(chunks[2]!.title).toBe("Section B");
    });

    test("markdown without headings returns single chunk", () => {
      const content = "Just a plain paragraph with no headings at all.";
      const chunks = parseFileToChunks(content, "plain.md", "markdown");
      expect(chunks.length).toBe(1);
      expect(chunks[0]!.path).toBe("plain.md");
    });

    test("json returns single chunk", () => {
      const content = '{"key": "value", "nested": {"a": 1}}';
      const chunks = parseFileToChunks(content, "config.json", "json");
      expect(chunks.length).toBe(1);
      expect(chunks[0]!.content).toBe(content);
    });

    test("plaintext splits on double newlines", () => {
      const content = "Paragraph one.\n\nParagraph two.\n\nParagraph three.";
      const chunks = parseFileToChunks(content, "notes.txt", "plaintext");
      expect(chunks.length).toBe(3);
      expect(chunks[0]!.content).toBe("Paragraph one.");
      expect(chunks[1]!.content).toBe("Paragraph two.");
    });

    test("single paragraph plaintext returns single chunk", () => {
      const content = "Just one paragraph.";
      const chunks = parseFileToChunks(content, "note.txt", "plaintext");
      expect(chunks.length).toBe(1);
    });

    test("unknown format treated as plaintext", () => {
      const content = "Some content\n\nMore content";
      const chunks = parseFileToChunks(content, "data.bin", "unknown");
      expect(chunks.length).toBe(2);
    });

    test("csv returns single chunk", () => {
      const content = "name,age\nAlice,30\nBob,25";
      const chunks = parseFileToChunks(content, "data.csv", "csv");
      expect(chunks.length).toBe(1);
      expect(chunks[0]!.content).toContain("Alice");
    });

    test("empty content returns 0 chunks", () => {
      expect(parseFileToChunks("", "empty.txt", "plaintext")).toEqual([]);
      expect(parseFileToChunks("", "empty.md", "markdown")).toEqual([]);
      expect(parseFileToChunks("", "empty.json", "json")).toEqual([]);
    });

    test("whitespace-only content returns 0 chunks", () => {
      expect(parseFileToChunks("   \n\n  ", "ws.txt", "plaintext")).toEqual([]);
    });

    test("all chunks carry filename as path", () => {
      const content = "# A\n\nText\n\n## B\n\nMore";
      const chunks = parseFileToChunks(content, "doc.md", "markdown");
      expect(chunks.every((c) => c.path === "doc.md")).toBe(true);
    });
  });
});
