import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { attachInlineForTest } from "../../files/test-helpers.ts";
import { createDeterministicHexFactory } from "../../test-helpers/determinism/ids.ts";
import { runExecution } from "../engine.ts";
import { createEngineCtx, createWorkflowRow, type EngineTestCtx } from "./setup.ts";

const nextHex = createDeterministicHexFactory(0xf11e1f);

interface CapturedRequest {
  contentType: string | null;
  body: Buffer;
}

function createCapturingServer(): {
  baseUrl: string;
  last: () => CapturedRequest | null;
  close: () => Promise<void>;
} {
  let captured: CapturedRequest | null = null;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      captured = {
        contentType: req.headers["content-type"] ?? null,
        body: Buffer.concat(chunks),
      };
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
  });
  server.listen(0, "127.0.0.1");
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    last: () => captured,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

let ctx: EngineTestCtx;
let srv: ReturnType<typeof createCapturingServer>;

beforeAll(async () => {
  ctx = await createEngineCtx("file-input");
  srv = createCapturingServer();
});

afterAll(async () => {
  await srv.close();
  await ctx.cleanup();
});

function uniqueBytes(tag: string): Buffer {
  return Buffer.concat([Buffer.from(nextHex(16), "hex"), Buffer.from(tag)]);
}

const FAKE_CONV_ID = "00000000-0000-0000-0000-000000000001";

describe("workflow file-input: multipart step with $file part", () => {
  test("POST sends multipart/form-data; bytes match source file", async () => {
    const fileContent = uniqueBytes("multipart-body-content");
    const att = await attachInlineForTest({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      conversation_id: FAKE_CONV_ID,
      filename: "report.pdf",
      content_type: "application/pdf",
      content: fileContent,
      slug: "report-pdf",
    });

    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "multipart-file-wf",
      steps: [
        {
          kind: "request",
          id: "upload",
          method: "POST",
          url: `${srv.baseUrl}/upload`,
          multipart: [
            { name: "file", file: { $file: att.file_id } },
            { name: "title", value: "Q1 Report" },
          ],
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

    const req = srv.last();
    expect(req).not.toBeNull();

    expect(req!.contentType).toContain("multipart/form-data");
    expect(req!.contentType).toContain("boundary=");

    const rawBody = req!.body.toString("binary");
    const expectedSlice = fileContent.subarray(0, 16).toString("binary");
    expect(rawBody).toContain(expectedSlice);

    expect(rawBody).toContain("Q1 Report");
  });

  test("unknown $file id → step fails (file not found)", async () => {
    const ghostFid = "fid_00000000-dead-beef-cafe-000000000001";

    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "ghost-file-wf",
      steps: [
        {
          kind: "request",
          id: "upload",
          method: "POST",
          url: `${srv.baseUrl}/upload`,
          multipart: [{ name: "file", file: { $file: ghostFid } }],
        },
      ],
    });

    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });

    expect(result.status).toBe("failed");
  });

  test("file + scalar part: both appear in FormData boundary", async () => {
    const content = uniqueBytes("mixed-multipart");
    const att = await attachInlineForTest({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      conversation_id: FAKE_CONV_ID,
      filename: "spec.json",
      content_type: "application/json",
      content,
      slug: "spec-json",
    });

    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "mixed-multipart-wf",
      steps: [
        {
          kind: "request",
          id: "post",
          method: "POST",
          url: `${srv.baseUrl}/upload`,
          multipart: [
            { name: "spec", file: { $file: att.file_id } },
            { name: "lang", value: "en" },
            { name: "version", value: "2" },
          ],
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
    const req = srv.last()!;
    const raw = req.body.toString("binary");
    expect(raw).toContain("lang");
    expect(raw).toContain("en");
    expect(raw).toContain("version");
    expect(raw).toContain("2");
  });
});
