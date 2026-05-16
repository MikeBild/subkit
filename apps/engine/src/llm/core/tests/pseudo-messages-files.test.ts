// Integration tests for LLM file-context assembly (D6 / Wave E).
//
// Tests:
//   - file_api strategy: mocked uploader called, block has correct shape
//   - file_part strategy (non-Files-API model): inline base64 block
//   - text_extract: file with unsupported capabilities forced to text extraction
//   - cap: 250 KiB per-turn inline cap forces overflow to text_extract
//   - persistence: second turn does NOT re-upload (mock counter stays at 1)
//
// Real Postgres via createHttpTestServer (config loaded). Mock LLM uploader.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { conversations, files } from "../../../db/schema/index.ts";
import { attachInlineForTest } from "../../../files/test-helpers.ts";
import { createHttpTestServer, type HttpTestServer } from "../../../http/tests/setup.ts";
import { getStaticCapabilities } from "../capabilities.ts";
import { buildFileContentBlocks, FILE_PART_PER_TURN_CAP_BYTES } from "../file-context.ts";
import type { UploadedFile, UploadFileParams } from "../files-api.ts";

let srv: HttpTestServer;
let conversation_id: string;

beforeAll(async () => {
  srv = await createHttpTestServer("pseudo-msg-files");

  const [conv] = await srv.db
    .insert(conversations)
    .values({ tenant_id: srv.tenantId, status: "active" })
    .returning();
  if (!conv) throw new Error("seed conv");
  conversation_id = conv.id;
}, 60_000);

afterAll(async () => {
  await srv.cleanup();
}, 30_000);

// Mock uploader factory — counts calls per filename
function makeMockUploader(uploadCounts: Map<string, number>) {
  return async (params: UploadFileParams): Promise<UploadedFile> => {
    const key = `${params.provider}:${params.filename}`;
    uploadCounts.set(key, (uploadCounts.get(key) ?? 0) + 1);
    return {
      file_id: `file_mock_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      provider: params.provider as "anthropic",
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      bytes: params.data.byteLength,
      filename: params.filename,
      mime_type: params.mimeType,
    };
  };
}

describe("buildFileContentBlocks — file_part strategy (mock model)", () => {
  test("small file with supportsFile=true → file_part block with data", async () => {
    const att = await attachInlineForTest({
      db: srv.db,
      tenant_id: srv.tenantId,
      conversation_id,
      filename: "small.pdf",
      content: "PDF content here",
      content_type: "application/pdf",
      slug: `small-pdf-${randomUUID().slice(0, 8)}`,
    });

    const caps = { ...getStaticCapabilities("mock"), supportsFile: true, filesApiSupport: false };

    const uploadCounts = new Map<string, number>();
    const result = await buildFileContentBlocks({
      db: srv.db,
      tenant_id: srv.tenantId,
      provider: "mock",
      capabilities: caps,
      fids: [att.file_id],
      uploader: makeMockUploader(uploadCounts),
    });

    expect(result.blocks).toHaveLength(1);
    const block = result.blocks[0]!;
    expect(block.strategy).toBe("file_part");
    if (block.strategy === "file_part") {
      expect(block.filename).toBe("small.pdf");
      expect(block.data.byteLength).toBeGreaterThan(0);
    }
    expect(uploadCounts.size).toBe(0); // No provider upload for file_part
    expect(result.inline_bytes).toBeGreaterThan(0);
  });

  test("file with supportsFile=false → text_extract block", async () => {
    const att = await attachInlineForTest({
      db: srv.db,
      tenant_id: srv.tenantId,
      conversation_id,
      filename: "text-only.txt",
      content: "plain text content for extraction",
      content_type: "text/plain",
      slug: `text-extract-${randomUUID().slice(0, 8)}`,
    });

    const caps = { ...getStaticCapabilities("mock"), supportsFile: false, filesApiSupport: false };

    const result = await buildFileContentBlocks({
      db: srv.db,
      tenant_id: srv.tenantId,
      provider: "mock",
      capabilities: caps,
      fids: [att.file_id],
      uploader: makeMockUploader(new Map()),
    });

    expect(result.blocks).toHaveLength(1);
    const block = result.blocks[0]!;
    expect(block.strategy).toBe("text_extract");
    if (block.strategy === "text_extract") {
      expect(block.text.length).toBeGreaterThan(0);
    }
  });
});

describe("buildFileContentBlocks — per-turn inline cap", () => {
  test("files exceeding 250 KiB cumulative cap are downgraded to text_extract", async () => {
    const chunkSize = Math.floor(FILE_PART_PER_TURN_CAP_BYTES * 0.6); // 60% of cap per file

    // Prefix every fixture with random bytes so sha256 is unique per
    // file (dedup would otherwise collapse identical-content rows).
    const { randomBytes } = await import("node:crypto");
    const makeContent = (size: number, tag: string) =>
      Buffer.concat([randomBytes(16), Buffer.alloc(Math.max(0, size - 16), tag)]);

    const att1 = await attachInlineForTest({
      db: srv.db,
      tenant_id: srv.tenantId,
      conversation_id,
      filename: "cap1.bin",
      content: makeContent(chunkSize, "X"),
      content_type: "application/octet-stream",
      slug: `cap1-${randomUUID().slice(0, 8)}`,
    });
    const att2 = await attachInlineForTest({
      db: srv.db,
      tenant_id: srv.tenantId,
      conversation_id,
      filename: "cap2.bin",
      content: makeContent(chunkSize, "Y"),
      content_type: "application/octet-stream",
      slug: `cap2-${randomUUID().slice(0, 8)}`,
    });

    const caps = {
      ...getStaticCapabilities("mock"),
      supportsFile: true,
      filesApiSupport: false,
      maxFileSizeMB: 100,
    };

    const result = await buildFileContentBlocks({
      db: srv.db,
      tenant_id: srv.tenantId,
      provider: "mock",
      capabilities: caps,
      fids: [att1.file_id, att2.file_id],
      uploader: makeMockUploader(new Map()),
    });

    expect(result.blocks).toHaveLength(2);
    // First should be file_part (within cap)
    expect(result.blocks[0]!.strategy).toBe("file_part");
    // Second should be text_extract (cap exceeded)
    expect(result.blocks[1]!.strategy).toBe("text_extract");
    expect(result.inline_cap_downgrades).toBe(1);
  });
});

describe("buildFileContentBlocks — file_api strategy", () => {
  test("file_api strategy: mocked uploader called once, block has provider file_id", async () => {
    // Create a file >5 MiB so chooseFileStrategy picks file_api
    const bigContent = Buffer.alloc(6 * 1024 * 1024, "B");
    const att = await attachInlineForTest({
      db: srv.db,
      tenant_id: srv.tenantId,
      conversation_id,
      filename: "big.pdf",
      content: bigContent,
      content_type: "application/pdf",
      slug: `big-pdf-${randomUUID().slice(0, 8)}`,
    });

    const caps = { ...getStaticCapabilities("anthropic") }; // filesApiSupport: true
    const uploadCounts = new Map<string, number>();

    const result = await buildFileContentBlocks({
      db: srv.db,
      tenant_id: srv.tenantId,
      provider: "anthropic",
      capabilities: caps,
      fids: [att.file_id],
      uploader: makeMockUploader(uploadCounts),
    });

    expect(result.blocks).toHaveLength(1);
    const block = result.blocks[0]!;
    expect(block.strategy).toBe("file_api");
    if (block.strategy === "file_api") {
      expect(block.provider).toBe("anthropic");
      expect(block.file_id).toMatch(/^file_mock_/);
      const native = block.native as { type: string; source: { type: string; file_id: string } };
      expect(native.type).toBe("document");
      expect(native.source.type).toBe("file");
      expect(native.source.file_id).toMatch(/^file_mock_/);
    }

    const totalCalls = Array.from(uploadCounts.values()).reduce((s, n) => s + n, 0);
    expect(totalCalls).toBe(1);
  });

  test("second turn with same fid does NOT re-upload (cached provider id)", async () => {
    const bigContent = Buffer.alloc(6 * 1024 * 1024, "C");
    const att = await attachInlineForTest({
      db: srv.db,
      tenant_id: srv.tenantId,
      conversation_id,
      filename: "cached.pdf",
      content: bigContent,
      content_type: "application/pdf",
      slug: `cached-pdf-${randomUUID().slice(0, 8)}`,
    });

    const caps = { ...getStaticCapabilities("anthropic") };
    const uploadCounts = new Map<string, number>();

    // Turn 1
    await buildFileContentBlocks({
      db: srv.db,
      tenant_id: srv.tenantId,
      provider: "anthropic",
      capabilities: caps,
      fids: [att.file_id],
      uploader: makeMockUploader(uploadCounts),
    });
    expect(Array.from(uploadCounts.values()).reduce((s, n) => s + n, 0)).toBe(1);

    // Verify provider id persisted
    const [row] = await srv.db.select().from(files).where(eq(files.id, att.file_uuid));
    expect(row!.anthropic_file_id).toBeTruthy();

    // Turn 2 — must NOT re-upload
    await buildFileContentBlocks({
      db: srv.db,
      tenant_id: srv.tenantId,
      provider: "anthropic",
      capabilities: caps,
      fids: [att.file_id],
      uploader: makeMockUploader(uploadCounts),
    });
    expect(Array.from(uploadCounts.values()).reduce((s, n) => s + n, 0)).toBe(1); // still 1
  });
});
