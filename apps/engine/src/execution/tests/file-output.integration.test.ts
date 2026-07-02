// Integration test: workflow steps that reference a $file ref in their output.
//
// Use-case: a transform step whose JS body returns
// `{ "$file": fid }` — the execution result carries the ref intact so
// downstream consumers can call GET /v1/files/{id}/content.
//
// We also verify the attached file's bytes are still readable after the
// execution completes (the file row and object-store entry are intact).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import { fileLinks, files } from "../../db/schema/files.ts";
import { buildObjectKey } from "../../files/object-key.ts";
import { requireFileForTenant } from "../../files/resolver.ts";
import { attachInlineForTest } from "../../files/test-helpers.ts";
import { getObjectStore } from "../../storage/object-store.ts";
import { createDeterministicHexFactory } from "../../test-helpers/determinism/ids.ts";
import { runExecution } from "../engine.ts";
import { createEngineCtx, createWorkflowRow, type EngineTestCtx } from "./setup.ts";

let ctx: EngineTestCtx;

// Deterministic 16-byte prefix per call: keeps sha256 unique across
// fixtures within the test while remaining replayable run-to-run.
const nextHex = createDeterministicHexFactory(0xf00e2f);

/** Unique bytes to avoid sha256 collision. */
function uniqueBytes(tag: string): Buffer {
  return Buffer.concat([Buffer.from(nextHex(16), "hex"), Buffer.from(tag)]);
}

const FAKE_CONV_ID = "00000000-0000-0000-0000-000000000002";

/** Spin up an HTTP server that returns a JSON body embedding a $file ref. */
function createFileRefServer(fid: string): {
  baseUrl: string;
  close: () => Promise<void>;
} {
  const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ result: { $file: fid }, status: "done" }));
  });
  server.listen(0, "127.0.0.1");
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

beforeAll(async () => {
  ctx = await createEngineCtx("file-output");
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("workflow file-output: $file ref in step result", () => {
  test("transform step returns $file ref; execution result carries ref intact", async () => {
    const fileContent = uniqueBytes("file-output-transform");
    const att = await attachInlineForTest({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      conversation_id: FAKE_CONV_ID,
      filename: "output.pdf",
      content_type: "application/pdf",
      content: fileContent,
      slug: "output-pdf",
    });

    // A transform step whose JS body produces a JSON object containing the
    // $file ref. We seed the input with the fid so the transform can pass
    // it through.
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "file-output-wf",
      steps: [
        {
          kind: "transform",
          id: "wrap",
          language: "javascript",
          // JS: return an object that passes through the fid from input.input.
          expression: `return { file_ref: input.input.fid, status: "done" };`,
        },
      ],
    });

    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: { fid: att.file_id },
    });

    expect(result.status).toBe("succeeded");
    // The file ref is in the execution output.
    const output = result.output as Record<string, unknown>;
    expect(output).not.toBeNull();
    expect(output.file_ref).toBe(att.file_id);
    expect(output.status).toBe("done");
  });

  test("HTTP step returns $file ref from target server; bytes still readable", async () => {
    const fileContent = uniqueBytes("file-output-http");
    const att = await attachInlineForTest({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      conversation_id: FAKE_CONV_ID,
      filename: "http-output.bin",
      content_type: "application/octet-stream",
      content: fileContent,
      slug: "http-output-bin",
    });

    // A mock HTTP server returns a JSON body with a $file ref.
    const srv = createFileRefServer(att.file_id);
    try {
      const { workflow_id } = await createWorkflowRow(ctx, {
        name: "http-file-output-wf",
        steps: [
          {
            kind: "request",
            id: "fetch",
            method: "GET",
            url: `${srv.baseUrl}/result`,
          },
        ],
      });

      const result = await runExecution({
        db: ctx.testDb.db,
        tenant_id: ctx.tenantId,
        source: { kind: "saved", workflow_id },
        input: null,
      });

      expect(result.status).toBe("succeeded");
      const output = result.output as { result: { $file: string }; status: string };
      expect(output.result.$file).toBe(att.file_id);
      expect(output.status).toBe("done");
    } finally {
      await srv.close();
    }

    // The file row and bytes must still be intact after the execution.
    const fileRow = await requireFileForTenant(ctx.testDb.db, ctx.tenantId, att.file_id);
    expect(fileRow.status).toBe("ready");
    expect(fileRow.filename).toBe("http-output.bin");

    const store = getObjectStore();
    const key = att.storage_key;
    const stored = await store.get(key);
    expect(stored.byteLength).toBe(fileContent.byteLength);
  });

  test("execution result with $file ref for unknown fid does not break engine", async () => {
    // The engine should succeed even if the output contains a fid that's
    // unknown — the step-runner does NOT validate output $file refs.
    // Only input resolution (walkAndResolve) triggers FileNotFoundError.
    const ghostFid = "fid_00000000-dead-beef-cafe-000000000002";
    const srv = createFileRefServer(ghostFid);
    try {
      const { workflow_id } = await createWorkflowRow(ctx, {
        name: "ghost-output-wf",
        steps: [
          {
            kind: "request",
            id: "fetch",
            method: "GET",
            url: `${srv.baseUrl}/ghost`,
          },
        ],
      });

      const result = await runExecution({
        db: ctx.testDb.db,
        tenant_id: ctx.tenantId,
        source: { kind: "saved", workflow_id },
        input: null,
      });

      // The HTTP step succeeds; the ghost fid in the output is just data.
      expect(result.status).toBe("succeeded");
      const output = result.output as { result: { $file: string } };
      expect(output.result.$file).toBe(ghostFid);
    } finally {
      await srv.close();
    }
  });
});

/** Serve fixed bytes with configurable headers (binary download vendor). */
function createBytesServer(
  bytes: Buffer,
  headers: Record<string, string>,
): { baseUrl: string; close: () => Promise<void> } {
  const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
    res.statusCode = 200;
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    res.end(bytes);
  });
  server.listen(0, "127.0.0.1");
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

interface PromotedEnvelope {
  file: { $file: string };
  filename: string;
  content_type: string | null;
  size_bytes: number;
}

async function runDownloadWorkflow(name: string, url: string) {
  const { workflow_id } = await createWorkflowRow(ctx, {
    name,
    steps: [{ kind: "request", id: "fetch", method: "GET", url }],
  });
  return runExecution({
    db: ctx.testDb.db,
    tenant_id: ctx.tenantId,
    source: { kind: "saved", workflow_id },
    input: null,
  });
}

describe("workflow file-output: binary HTTP response promoted to engine-managed file", () => {
  // Deliberately invalid UTF-8 (0x00, 0x80, 0xff) — the pre-promotion
  // driver decoded these to U+FFFD irreversibly.
  const pdfBytes = Buffer.concat([
    Buffer.from("%PDF-1.7\n"),
    Buffer.from([0x00, 0x80, 0xff, 0xfe, 0x01]),
    uniqueBytes("promoted-pdf-payload"),
  ]);

  test("PDF + attachment disposition → files row, workflow_run link, envelope output, exact bytes", async () => {
    const srv = createBytesServer(pdfBytes, {
      "content-type": "application/pdf",
      "content-disposition": 'attachment; filename="report.pdf"',
    });
    try {
      const result = await runDownloadWorkflow("binary-promote-wf", `${srv.baseUrl}/export`);
      expect(result.status).toBe("succeeded");

      const output = result.output as PromotedEnvelope;
      expect(output.file.$file).toMatch(/^fid_[0-9a-f-]{36}$/);
      expect(output.filename).toBe("report.pdf");
      expect(output.content_type).toBe("application/pdf");
      expect(output.size_bytes).toBe(pdfBytes.byteLength);

      // files row via the tenant chokepoint
      const fileRow = await requireFileForTenant(ctx.testDb.db, ctx.tenantId, output.file.$file);
      expect(fileRow.status).toBe("ready");
      expect(fileRow.filename).toBe("report.pdf");
      expect(fileRow.content_type).toBe("application/pdf");
      expect(Number(fileRow.size_bytes)).toBe(pdfBytes.byteLength);

      // workflow_run link with role=output pointing at THIS execution
      const links = await ctx.testDb.db
        .select()
        .from(fileLinks)
        .where(
          and(
            eq(fileLinks.tenant_id, ctx.tenantId),
            eq(fileLinks.file_id, fileRow.id),
            eq(fileLinks.resource_type, "workflow_run"),
          ),
        );
      expect(links).toHaveLength(1);
      expect(links[0]!.resource_id).toBe(result.execution_id);
      expect(links[0]!.role).toBe("output");

      // Bytes round-trip EXACTLY (the corruption regression lock)
      const stored = await getObjectStore().get(buildObjectKey(ctx.tenantId, fileRow.id));
      expect(Buffer.compare(Buffer.from(stored), pdfBytes)).toBe(0);
    } finally {
      await srv.close();
    }
  });

  test("same bytes across two runs dedup to one files row with a link per run", async () => {
    const dedupBytes = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]),
      uniqueBytes("dedup-zip-payload"),
    ]);
    const srv = createBytesServer(dedupBytes, { "content-type": "application/zip" });
    try {
      const r1 = await runDownloadWorkflow("dedup-promote-wf-1", `${srv.baseUrl}/a.zip`);
      const r2 = await runDownloadWorkflow("dedup-promote-wf-2", `${srv.baseUrl}/a.zip`);
      expect(r1.status).toBe("succeeded");
      expect(r2.status).toBe("succeeded");

      const fid1 = (r1.output as PromotedEnvelope).file.$file;
      const fid2 = (r2.output as PromotedEnvelope).file.$file;
      expect(fid1).toBe(fid2); // one row, sha256 dedup

      const fileRow = await requireFileForTenant(ctx.testDb.db, ctx.tenantId, fid1);
      const links = await ctx.testDb.db
        .select()
        .from(fileLinks)
        .where(
          and(
            eq(fileLinks.tenant_id, ctx.tenantId),
            eq(fileLinks.file_id, fileRow.id),
            eq(fileLinks.resource_type, "workflow_run"),
          ),
        );
      expect(links).toHaveLength(2);
      expect(new Set(links.map((l) => l.resource_id))).toEqual(
        new Set([r1.execution_id, r2.execution_id]),
      );
    } finally {
      await srv.close();
    }
  });

  test("JSON response stays parsed step data — no promotion (regression guard)", async () => {
    const srv = createBytesServer(Buffer.from(JSON.stringify({ items: [1, 2, 3] })), {
      "content-type": "application/json",
    });
    try {
      const result = await runDownloadWorkflow("json-no-promote-wf", `${srv.baseUrl}/items`);
      expect(result.status).toBe("succeeded");
      expect(result.output).toEqual({ items: [1, 2, 3] });
    } finally {
      await srv.close();
    }
  });

  test("octet-stream-labeled JSON still parses via the shape sniffer (mislabel guard)", async () => {
    const srv = createBytesServer(Buffer.from(JSON.stringify({ ok: true })), {
      "content-type": "application/octet-stream",
    });
    try {
      const result = await runDownloadWorkflow("octet-json-wf", `${srv.baseUrl}/data`);
      expect(result.status).toBe("succeeded");
      expect(result.output).toEqual({ ok: true });
    } finally {
      await srv.close();
    }
  });

  test("chained runs: run 1's promoted output file feeds run 2's multipart input", async () => {
    const chainBytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]), // PNG magic + NUL
      uniqueBytes("chained-png-payload"),
    ]);
    const download = createBytesServer(chainBytes, { "content-type": "image/png" });

    // Capture server for run 2's multipart POST.
    let capturedBody: Buffer | null = null;
    const capture = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        capturedBody = Buffer.concat(chunks);
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ received: true }));
      });
    });
    capture.listen(0, "127.0.0.1");
    const capturePort = (capture.address() as AddressInfo).port;

    try {
      const r1 = await runDownloadWorkflow("chain-produce-wf", `${download.baseUrl}/pic.png`);
      expect(r1.status).toBe("succeeded");
      const fid = (r1.output as PromotedEnvelope).file.$file;

      const { workflow_id } = await createWorkflowRow(ctx, {
        name: "chain-consume-wf",
        steps: [
          {
            kind: "request",
            id: "upload",
            method: "POST",
            url: `http://127.0.0.1:${capturePort}/upload`,
            multipart: [{ name: "blob", file: { $file: fid } }],
          },
        ],
      });
      const r2 = await runExecution({
        db: ctx.testDb.db,
        tenant_id: ctx.tenantId,
        source: { kind: "saved", workflow_id },
        input: null,
      });
      expect(r2.status).toBe("succeeded");
      expect(capturedBody).not.toBeNull();
      // The promoted bytes round-tripped into the multipart body intact.
      expect(capturedBody!.toString("binary")).toContain(chainBytes.toString("binary"));
    } finally {
      await download.close();
      await new Promise<void>((r) => capture.close(() => r()));
    }
  });
});
