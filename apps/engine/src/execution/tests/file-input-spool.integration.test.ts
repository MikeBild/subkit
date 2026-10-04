import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { SPOOL_THRESHOLD_BYTES } from "../../files/resolver.ts";
import { attachInlineForTest } from "../../files/test-helpers.ts";
import { createDeterministicHexFactory } from "../../test-helpers/determinism/ids.ts";
import { runExecution } from "../engine.ts";
import { createEngineCtx, createWorkflowRow, type EngineTestCtx } from "./setup.ts";

const nextHex = createDeterministicHexFactory(0xf11e57);

interface CapturedRequest {
  contentType: string | null;
  contentLength: number;
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
      const body = Buffer.concat(chunks);
      captured = {
        contentType: req.headers["content-type"] ?? null,
        contentLength: body.byteLength,
        body,
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
  ctx = await createEngineCtx("file-input-spool");
  srv = createCapturingServer();
}, 60_000);

afterAll(async () => {
  await srv.close();
  await ctx.cleanup();
}, 30_000);

const FAKE_CONV_ID = "00000000-0000-0000-0000-000000000777";

describe("workflow file-input: large multipart `$file` exceeds SPOOL_THRESHOLD_BYTES", () => {
  test("multipart upload of a file > SPOOL_THRESHOLD_BYTES succeeds (spool reads via ResolvedFile.openRead)", async () => {
    const overflow = SPOOL_THRESHOLD_BYTES + 1;
    const prefix = Buffer.from(nextHex(16), "hex");
    const filler = Buffer.alloc(overflow - prefix.length, 0x41);
    const fileContent = Buffer.concat([prefix, filler]);
    expect(fileContent.byteLength).toBe(overflow);

    const att = await attachInlineForTest({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      conversation_id: FAKE_CONV_ID,
      filename: "huge.bin",
      content_type: "application/octet-stream",
      content: fileContent,
      slug: "huge-bin",
    });

    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "spool-multipart-wf",
      steps: [
        {
          kind: "request",
          id: "upload",
          method: "POST",
          url: `${srv.baseUrl}/upload`,
          multipart: [{ name: "blob", file: { $file: att.file_id } }],
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

    const captured = srv.last();
    expect(captured).not.toBeNull();
    expect(captured!.contentType).toContain("multipart/form-data");
    expect(captured!.contentLength).toBeGreaterThanOrEqual(overflow);
    expect(captured!.body.toString("binary")).toContain(prefix.toString("binary"));
  }, 120_000);
});
