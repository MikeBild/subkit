// Integration test: workflow steps that reference a $file ref in their output.
//
// Use-case: a transform step whose JSONata expression returns
// `{ "$file": fid }` — the execution result carries the ref intact so
// downstream consumers can call GET /v1/files/{id}/content.
//
// We also verify the attached file's bytes are still readable after the
// execution completes (the file row and object-store entry are intact).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
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

    // A transform step whose expression produces a JSON object containing the
    // $file ref.  JSONata `$` expression returns the input unchanged.
    // We seed the input with the fid so the transform can pass it through.
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "file-output-wf",
      steps: [
        {
          kind: "transform",
          id: "wrap",
          // JSONata: return an object that passes through the fid from $input.
          expression: `{ "file_ref": $input.fid, "status": "done" }`,
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
