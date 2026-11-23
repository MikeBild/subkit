import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetConfigForTests, loadConfig } from "../../config/loader.ts";
import { persistInlineUpload } from "../../files/persist-inline-upload.ts";
import {
  buildDocxFixture,
  buildPdfFixture,
  buildXlsxFixture,
  buildZipFixture,
} from "../../test-helpers/binary-fixtures.ts";
import { runExecution } from "../engine.ts";
import { createEngineCtx, createWorkflowRow, type EngineTestCtx } from "./setup.ts";

let ctx: EngineTestCtx;
let configDir: string;

beforeAll(async () => {
  ctx = await createEngineCtx("parse-file");
  configDir = mkdtempSync(join(tmpdir(), "subkit-parse-file-"));
  _resetConfigForTests();
  await loadConfig({
    env: { NODE_ENV: "test", DATABASE_URL: ctx.testDb.url },
    configPathOverride: join(configDir, "subkit.config.json"),
  });
});

afterAll(async () => {
  await ctx.cleanup();
  _resetConfigForTests();
  rmSync(configDir, { recursive: true, force: true });
});

async function upload(filename: string, content_type: string | null, bytes: Uint8Array) {
  const { row } = await persistInlineUpload(ctx.testDb.db, {
    tenant_id: ctx.tenantId,
    actor_id: null,
    filename,
    content_type,
    bytes,
  });
  return { $file: `fid_${row.id}` };
}

async function parse(file: Record<string, unknown>, input: unknown) {
  const { workflow_id } = await createWorkflowRow(ctx, {
    name: "parse file",
    steps: [{ id: "read", kind: "transform", language: "parse-file", file }],
  });
  return runExecution({
    db: ctx.testDb.db,
    tenant_id: ctx.tenantId,
    source: { kind: "saved", workflow_id },
    input,
  });
}

describe("transform language parse-file", () => {
  test("a CSV input becomes rows keyed by the header, bounded by max_rows", async () => {
    const doc = await upload(
      "orders.csv",
      "text/csv",
      new TextEncoder().encode("id,total\n1,10\n2,20\n3,30\n"),
    );
    const result = await parse({ source: "$input.doc", max_rows: 2 }, { doc });
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual({
      format: "csv",
      filename: "orders.csv",
      rows: [
        { id: "1", total: "10" },
        { id: "2", total: "20" },
      ],
      row_count: 3,
      truncated: true,
    });
  });

  test("a spreadsheet is read sheet by sheet", async () => {
    const doc = await upload(
      "report.xlsx",
      null,
      buildXlsxFixture({ Summary: [{ a: 1 }], Detail: [{ name: "Ada", hours: 4 }] }),
    );
    const result = await parse({ source: "$input.doc", sheet: "Detail" }, { doc });
    expect(result.status).toBe("succeeded");
    expect(result.output).toMatchObject({
      format: "xlsx",
      sheet: "Detail",
      sheets: ["Summary", "Detail"],
      rows: [{ name: "Ada", hours: 4 }],
      truncated: false,
    });
    const missing = await parse({ source: "$input.doc", sheet: "Nope" }, { doc });
    expect(missing.error?.code).toBe("parse_file_sheet_missing");
  });

  test("PDF, DOCX and ZIP files are recognised from their bytes", async () => {
    const pdf = await upload("invoice.pdf", null, buildPdfFixture("Invoice 4711"));
    const pdfRun = await parse({ source: "$input.doc" }, { doc: pdf });
    expect(pdfRun.status).toBe("succeeded");
    expect(pdfRun.output).toMatchObject({ format: "pdf", pages: 1 });
    expect(String((pdfRun.output as { text: string }).text)).toContain("Invoice 4711");

    const docx = await upload("note.docx", null, await buildDocxFixture("Title", "Body text"));
    const docxRun = await parse({ source: "$input.doc" }, { doc: docx });
    expect(docxRun.output).toMatchObject({ format: "docx" });
    expect(String((docxRun.output as { text: string }).text)).toContain("Body text");

    const zip = await upload(
      "bundle.zip",
      null,
      buildZipFixture([{ name: "readme.txt", data: "hello" }]),
    );
    const zipRun = await parse({ source: "$input.doc", format: "zip" }, { doc: zip });
    expect(zipRun.status).toBe("succeeded");
    expect(zipRun.output).toMatchObject({ format: "zip" });
  });

  test("a missing file reference fails with a plain reason", async () => {
    const result = await parse({ source: "$input.nothing" }, {});
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("parse_file_source_missing");
  });
});
