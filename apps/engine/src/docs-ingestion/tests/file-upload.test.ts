// File-upload source ingestion test.
//
// Round-trips one fixture per supported format (JSON, CSV, YAML, XML,
// Markdown, plaintext, HTML, and the binary office formats PDF/DOCX/
// XLSX/PPTX) and asserts the orchestrator persists at least one chunk
// for each. Genuinely-unknown formats (e.g. `.exe`) still surface as
// `UnsupportedFileUploadError`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  buildDocxFixture,
  buildPdfFixture,
  buildPptxFixture,
  buildXlsxFixture,
} from "../../test-helpers/binary-fixtures.ts";
import { ingestDocs } from "../service.ts";
import {
  ingestFileUpload,
  parseCsv,
  parseSimpleXml,
  parseSimpleYaml,
  UnsupportedFileUploadError,
} from "../sources/file-upload.ts";
import { createDocsTestCtx, type DocsTestCtx } from "./setup.ts";

let ctx: DocsTestCtx;

beforeAll(async () => {
  ctx = await createDocsTestCtx("file_upload");
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("docs-ingestion/file-upload", () => {
  test("parses a tiny json fixture", async () => {
    const result = await ingestDocs(
      {
        tenant_id: ctx.tenantId,
        connector_id: ctx.connectorId,
        input: {
          source_type: "file_upload",
          upload: {
            buffer: JSON.stringify({ hello: "world", nested: { a: 1 } }),
            filename: "fixture.json",
          },
        },
      },
      ctx.testDb.db,
    );
    expect(result.ingested_count).toBeGreaterThanOrEqual(1);
  });

  test("parses a tiny csv fixture", async () => {
    const csv = "id,name,role\n1,alice,admin\n2,bob,member\n";
    const parsed = parseCsv(csv);
    expect(parsed.headers).toEqual(["id", "name", "role"]);
    expect(parsed.rows.length).toBe(2);

    const result = await ingestDocs(
      {
        tenant_id: ctx.tenantId,
        connector_id: ctx.connectorId,
        input: {
          source_type: "file_upload",
          upload: { buffer: csv, filename: "fixture.csv" },
        },
      },
      ctx.testDb.db,
    );
    // header chunk + 2 row chunks = 3
    expect(result.ingested_count).toBe(3);
  });

  test("parses a tiny yaml fixture", async () => {
    const yaml = "name: subkit\nversion: 1\nflags:\n  - alpha\n  - beta\n";
    const parsed = parseSimpleYaml(yaml);
    expect(parsed.name).toBe("subkit");
    expect(parsed.version).toBe(1);

    const result = await ingestDocs(
      {
        tenant_id: ctx.tenantId,
        connector_id: ctx.connectorId,
        input: {
          source_type: "file_upload",
          upload: { buffer: yaml, filename: "fixture.yaml" },
        },
      },
      ctx.testDb.db,
    );
    expect(result.ingested_count).toBeGreaterThanOrEqual(1);
  });

  test("parses a tiny xml fixture", async () => {
    const xml =
      '<?xml version="1.0"?><root><item id="1">alpha</item><item id="2">beta</item></root>';
    const parsed = parseSimpleXml(xml);
    expect(parsed.children.length).toBe(1);

    const result = await ingestDocs(
      {
        tenant_id: ctx.tenantId,
        connector_id: ctx.connectorId,
        input: {
          source_type: "file_upload",
          upload: { buffer: xml, filename: "fixture.xml" },
        },
      },
      ctx.testDb.db,
    );
    expect(result.ingested_count).toBeGreaterThanOrEqual(1);
  });

  test("rejects genuinely-unknown formats", async () => {
    await expect(
      ingestFileUpload({ buffer: Buffer.from([0]), filename: "binary.exe" }),
    ).rejects.toBeInstanceOf(UnsupportedFileUploadError);
  });

  test("parses a tiny pdf fixture", async () => {
    const pdf = buildPdfFixture("Hello PDF.");
    const result = await ingestFileUpload({ buffer: pdf, filename: "fixture.pdf" });
    expect(result.format).toBe("pdf");
    expect(result.chunks.length).toBeGreaterThanOrEqual(1);
    expect(result.chunks[0]?.content).toContain("Hello PDF");
  });

  test("parses a tiny docx fixture", async () => {
    const docx = await buildDocxFixture("Hello DOCX heading", "Body paragraph here.");
    const result = await ingestFileUpload({ buffer: docx, filename: "fixture.docx" });
    expect(result.format).toBe("docx");
    expect(result.chunks.length).toBeGreaterThanOrEqual(1);
    const joined = result.chunks.map((c) => c.content).join("\n");
    expect(joined).toMatch(/Hello DOCX heading/);
  });

  test("parses a tiny xlsx fixture", async () => {
    const xlsx = buildXlsxFixture({
      Sheet1: [
        { id: 1, name: "alice" },
        { id: 2, name: "bob" },
      ],
    });
    const result = await ingestFileUpload({ buffer: xlsx, filename: "fixture.xlsx" });
    expect(result.format).toBe("xlsx");
    expect(result.chunks.length).toBe(1);
    expect(result.chunks[0]?.content).toContain("alice");
  });

  test("parses a tiny pptx fixture", async () => {
    const pptx = await buildPptxFixture(["Slide one body", "Slide two body"]);
    const result = await ingestFileUpload({ buffer: pptx, filename: "fixture.pptx" });
    expect(result.format).toBe("pptx");
    expect(result.chunks.length).toBe(2);
    expect(result.chunks[0]?.content).toContain("Slide one body");
  });

  test("parses a Markdown README into heading-split chunks", async () => {
    const md = [
      "# Acme API",
      "",
      "Acme is a sample API for testing.",
      "",
      "## Authentication",
      "",
      "Use a Bearer token in the Authorization header.",
      "",
      "## Endpoints",
      "",
      "- GET /widgets — list widgets",
      "- POST /widgets — create a widget",
    ].join("\n");
    const result = await ingestDocs(
      {
        tenant_id: ctx.tenantId,
        connector_id: ctx.connectorId,
        input: {
          source_type: "file_upload",
          upload: { buffer: md, filename: "README.md" },
        },
      },
      ctx.testDb.db,
    );
    expect(result.ingested_count).toBeGreaterThanOrEqual(2);
  });

  test("parses a plaintext upload into paragraph chunks", async () => {
    const text = "First paragraph about the API.\n\nSecond paragraph describing endpoints.";
    const result = await ingestDocs(
      {
        tenant_id: ctx.tenantId,
        connector_id: ctx.connectorId,
        input: {
          source_type: "file_upload",
          upload: { buffer: text, filename: "notes.txt", mime: "text/plain" },
        },
      },
      ctx.testDb.db,
    );
    expect(result.ingested_count).toBeGreaterThanOrEqual(1);
  });

  test("treats an HTML upload as text and produces at least one chunk", async () => {
    const html = "<html><body><h1>Hello</h1><p>World.</p></body></html>";
    const result = await ingestDocs(
      {
        tenant_id: ctx.tenantId,
        connector_id: ctx.connectorId,
        input: {
          source_type: "file_upload",
          upload: { buffer: html, filename: "index.html", mime: "text/html" },
        },
      },
      ctx.testDb.db,
    );
    expect(result.ingested_count).toBeGreaterThanOrEqual(1);
  });
});
