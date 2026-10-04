import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { conversations } from "../../../db/schema/index.ts";
import { attachInlineForTest } from "../../../files/test-helpers.ts";
import { createHttpTestServer, type HttpTestServer } from "../../../http/tests/setup.ts";
import {
  createDeterministicHexFactory,
  createDeterministicUuidFactory,
} from "../../../test-helpers/determinism/ids.ts";
import { getStaticCapabilities } from "../capabilities.ts";
import { buildFileContentBlocks, FILE_PART_PER_TURN_CAP_BYTES } from "../file-context.ts";

const uuid = createDeterministicUuidFactory(0xb31a91);
const nextHex = createDeterministicHexFactory(0xb31a92);

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

describe("buildFileContentBlocks — file_part strategy (mock model)", () => {
  test("small file with supportsFile=true → file_part block with data", async () => {
    const att = await attachInlineForTest({
      db: srv.db,
      tenant_id: srv.tenantId,
      conversation_id,
      filename: "small.pdf",
      content: "PDF content here",
      content_type: "application/pdf",
      slug: `small-pdf-${uuid().slice(0, 8)}`,
    });

    const caps = { ...getStaticCapabilities("mock"), supportsFile: true };

    const uploadCounts = new Map<string, number>();
    const result = await buildFileContentBlocks({
      db: srv.db,
      tenant_id: srv.tenantId,
      capabilities: caps,
      fids: [att.file_id],
    });

    expect(result.blocks).toHaveLength(1);
    const block = result.blocks[0]!;
    expect(block.strategy).toBe("file_part");
    if (block.strategy === "file_part") {
      expect(block.filename).toBe("small.pdf");
      expect(block.data.byteLength).toBeGreaterThan(0);
    }
    expect(uploadCounts.size).toBe(0);
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
      slug: `text-extract-${uuid().slice(0, 8)}`,
    });

    const caps = { ...getStaticCapabilities("mock"), supportsFile: false };

    const result = await buildFileContentBlocks({
      db: srv.db,
      tenant_id: srv.tenantId,
      capabilities: caps,
      fids: [att.file_id],
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
    const chunkSize = Math.floor(FILE_PART_PER_TURN_CAP_BYTES * 0.6);

    const makeContent = (size: number, tag: string) =>
      Buffer.concat([Buffer.from(nextHex(16), "hex"), Buffer.alloc(Math.max(0, size - 16), tag)]);

    const att1 = await attachInlineForTest({
      db: srv.db,
      tenant_id: srv.tenantId,
      conversation_id,
      filename: "cap1.png",
      content: makeContent(chunkSize, "X"),
      content_type: "image/png",
      slug: `cap1-${uuid().slice(0, 8)}`,
    });
    const att2 = await attachInlineForTest({
      db: srv.db,
      tenant_id: srv.tenantId,
      conversation_id,
      filename: "cap2.png",
      content: makeContent(chunkSize, "Y"),
      content_type: "image/png",
      slug: `cap2-${uuid().slice(0, 8)}`,
    });

    const caps = {
      ...getStaticCapabilities("mock"),
      supportsFile: true,
      maxFileSizeMB: 100,
    };

    const result = await buildFileContentBlocks({
      db: srv.db,
      tenant_id: srv.tenantId,
      capabilities: caps,
      fids: [att1.file_id, att2.file_id],
    });

    expect(result.blocks).toHaveLength(2);
    expect(result.blocks[0]!.strategy).toBe("file_part");
    expect(result.blocks[1]!.strategy).toBe("text_extract");
    expect(result.inline_cap_downgrades).toBe(1);
  });
});
