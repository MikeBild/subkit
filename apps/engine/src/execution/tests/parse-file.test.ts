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
import {
  type MemoryOffloadStorage,
  useMemoryOffloadStorage,
} from "../../test-helpers/offload-storage.ts";
import { runExecution } from "../engine.ts";
import { createEngineCtx, createWorkflowRow, type EngineTestCtx } from "./setup.ts";

let ctx: EngineTestCtx;
let configDir: string;
let storage: MemoryOffloadStorage;

beforeAll(async () => {
  ctx = await createEngineCtx("parse-file");
  configDir = mkdtempSync(join(tmpdir(), "subkit-parse-file-"));
  _resetConfigForTests();
  await loadConfig({
    env: { NODE_ENV: "test", DATABASE_URL: ctx.testDb.url },
    configPathOverride: join(configDir, "subkit.config.json"),
  });
  storage = await useMemoryOffloadStorage();
});

afterAll(async () => {
  await storage.restore();
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

  test("a CSV past the row limit is cut and still reports every row", async () => {
    const lines = ["id,name"];
    for (let i = 1; i <= 20_000; i += 1) lines.push(`${i},row ${i}`);
    const doc = await upload("big.csv", "text/csv", new TextEncoder().encode(lines.join("\n")));
    const result = await parse({ source: "$input.doc" }, { doc });
    expect(result.status).toBe("succeeded");
    const output = result.output as { rows: unknown[]; row_count: number; truncated: boolean };
    expect(output.rows).toHaveLength(10_000);
    expect(output.rows[9_999]).toEqual({ id: "10000", name: "row 10000" });
    expect(output.row_count).toBe(20_000);
    expect(output.truncated).toBe(true);
  }, 60_000);

  test("a CSV over one megabyte parses", async () => {
    const filler = "x".repeat(200);
    const lines = ["id,text"];
    for (let i = 0; i < 6_000; i += 1) lines.push(`${i},${filler}`);
    const bytes = new TextEncoder().encode(lines.join("\n"));
    expect(bytes.byteLength).toBeGreaterThan(1024 * 1024);
    const doc = await upload("wide.csv", "text/csv", bytes);
    const result = await parse({ source: "$input.doc", max_rows: 5 }, { doc });
    expect(result.status).toBe("succeeded");
    expect(result.output).toMatchObject({ row_count: 6_000, truncated: true });
    expect((result.output as { rows: unknown[] }).rows).toHaveLength(5);
  }, 60_000);

  test("a malformed CSV fails with the parser's reason", async () => {
    const doc = await upload("bad.csv", "text/csv", new TextEncoder().encode('a,b\n1,"open\n'));
    const result = await parse({ source: "$input.doc" }, { doc });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("parse_file_failed");
    expect(result.error?.message).toStartWith("The CSV file is malformed:");
  });

  test("a regional Excel export with semicolons and Windows-1252 yields columns", async () => {
    const bytes = new Uint8Array([
      ...new TextEncoder().encode("customer;amount\nRen"),
      0xe9,
      ...new TextEncoder().encode("e;12,50\n"),
    ]);
    const doc = await upload("export.csv", "text/csv", bytes);
    const result = await parse({ source: "$input.doc" }, { doc });
    expect(result.status).toBe("succeeded");
    expect(result.output).toMatchObject({ rows: [{ customer: "Renée", amount: "12,50" }] });
  });

  test("a delimiter named in the step overrides detection", async () => {
    const doc = await upload(
      "codes.csv",
      "text/csv",
      new TextEncoder().encode("code,region;amount\nA,North;12\n"),
    );
    const detected = await parse({ source: "$input.doc" }, { doc });
    expect(detected.output).toMatchObject({ rows: [{ code: "A", "region;amount": "North;12" }] });
    const named = await parse({ source: "$input.doc", delimiter: ";" }, { doc });
    expect(named.status).toBe("succeeded");
    expect(named.output).toMatchObject({ rows: [{ "code,region": "A,North", amount: "12" }] });
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
