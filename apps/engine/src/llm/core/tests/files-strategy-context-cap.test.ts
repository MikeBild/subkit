import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { conversations, tenants } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { attachInlineForTest } from "../../../files/test-helpers.ts";
import {
  createDeterministicHexFactory,
  createDeterministicUuidFactory,
} from "../../../test-helpers/determinism/ids.ts";
import { getStaticCapabilities } from "../capabilities.ts";
import { buildFileContentBlocks, FILE_PART_PER_TURN_CAP_BYTES } from "../file-context.ts";

const uuid = createDeterministicUuidFactory(0xfacaa1);
const nextHex = createDeterministicHexFactory(0xfacaa2);

function uniqueBuffer(size: number, fill: string): Buffer {
  const prefix = Buffer.from(nextHex(16), "hex");
  return Buffer.concat([prefix, Buffer.alloc(Math.max(0, size - 16), fill)]);
}

let ctx: TestDb;
let tenant_id: string;
let conversation_id: string;

beforeAll(async () => {
  ctx = await createTestDb("files-strategy-cap");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "fscap-t", display_name: "Files Strategy Cap" })
    .returning();
  if (!t) throw new Error("seed tenant");
  tenant_id = t.id;

  const [conv] = await ctx.db
    .insert(conversations)
    .values({ tenant_id, status: "active" })
    .returning();
  if (!conv) throw new Error("seed conv");
  conversation_id = conv.id;
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

describe("250 KiB per-turn inline cap", () => {
  test("single file under cap → file_part, no downgrades", async () => {
    const content = uniqueBuffer(10 * 1024, "A");
    const att = await attachInlineForTest({
      db: ctx.db,
      tenant_id,
      conversation_id,
      filename: "under-cap.png",
      content,
      content_type: "image/png",
      slug: `under-cap-${uuid().slice(0, 8)}`,
    });

    const caps = {
      ...getStaticCapabilities("mock"),
      supportsFile: true,
      maxFileSizeMB: 100,
    };

    const result = await buildFileContentBlocks({
      db: ctx.db,
      tenant_id,
      capabilities: caps,
      fids: [att.file_id],
    });

    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]!.strategy).toBe("file_part");
    expect(result.inline_cap_downgrades).toBe(0);
    expect(result.inline_bytes).toBe(content.byteLength);
  });

  test("FILE_PART_PER_TURN_CAP_BYTES constant is 250 KiB", () => {
    expect(FILE_PART_PER_TURN_CAP_BYTES).toBe(250 * 1024);
  });

  test("two files where second crosses cap → first is file_part, second is text_extract", async () => {
    const size = 160 * 1024;
    const content1 = uniqueBuffer(size, "B");
    const content2 = uniqueBuffer(size, "b");

    const att1 = await attachInlineForTest({
      db: ctx.db,
      tenant_id,
      conversation_id,
      filename: "cap-file1.png",
      content: content1,
      content_type: "image/png",
      slug: `cap-f1-${uuid().slice(0, 8)}`,
    });
    const att2 = await attachInlineForTest({
      db: ctx.db,
      tenant_id,
      conversation_id,
      filename: "cap-file2.png",
      content: content2,
      content_type: "image/png",
      slug: `cap-f2-${uuid().slice(0, 8)}`,
    });

    const caps = {
      ...getStaticCapabilities("mock"),
      supportsFile: true,
      maxFileSizeMB: 100,
    };

    const result = await buildFileContentBlocks({
      db: ctx.db,
      tenant_id,
      capabilities: caps,
      fids: [att1.file_id, att2.file_id],
    });

    expect(result.blocks).toHaveLength(2);
    expect(result.blocks[0]!.strategy).toBe("file_part");
    expect(result.blocks[1]!.strategy).toBe("text_extract");
    expect(result.inline_cap_downgrades).toBe(1);
  });

  test("three files where 2nd + 3rd both exceed cap → both are text_extract, 2 downgrades", async () => {
    const firstSize = 80 * 1024;
    const bigSize = 200 * 1024;

    const firstContent = uniqueBuffer(firstSize, "C");
    const bigContent2 = uniqueBuffer(bigSize, "D");
    const bigContent3 = uniqueBuffer(bigSize, "d");

    const att1 = await attachInlineForTest({
      db: ctx.db,
      tenant_id,
      conversation_id,
      filename: "triple-1.png",
      content: firstContent,
      content_type: "image/png",
      slug: `triple-1-${uuid().slice(0, 8)}`,
    });
    const att2 = await attachInlineForTest({
      db: ctx.db,
      tenant_id,
      conversation_id,
      filename: "triple-2.png",
      content: bigContent2,
      content_type: "image/png",
      slug: `triple-2-${uuid().slice(0, 8)}`,
    });
    const att3 = await attachInlineForTest({
      db: ctx.db,
      tenant_id,
      conversation_id,
      filename: "triple-3.png",
      content: bigContent3,
      content_type: "image/png",
      slug: `triple-3-${uuid().slice(0, 8)}`,
    });

    const caps = {
      ...getStaticCapabilities("mock"),
      supportsFile: true,
      maxFileSizeMB: 100,
    };

    const result = await buildFileContentBlocks({
      db: ctx.db,
      tenant_id,
      capabilities: caps,
      fids: [att1.file_id, att2.file_id, att3.file_id],
    });

    expect(result.blocks).toHaveLength(3);
    expect(result.blocks[0]!.strategy).toBe("file_part");
    expect(result.blocks[1]!.strategy).toBe("text_extract");
    expect(result.blocks[2]!.strategy).toBe("text_extract");
    expect(result.inline_cap_downgrades).toBe(2);
    expect(result.inline_bytes).toBe(firstSize);
  });
});
