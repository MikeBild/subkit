// Integration test: 250 KiB per-turn inline cap forces overflow files to
// text_extract, and `inline_cap_downgrades` counter increments correctly.
//
// Does NOT call a real LLM. Uses the mock uploader pattern.

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

// Deterministic id sources: seeded so the test replays identically.
// createTestDb provisions a fresh DB per run, so per-call uniqueness
// within the test is sufficient to keep sha256 distinct across fixtures.
const uuid = createDeterministicUuidFactory(0xfacaa1);
const nextHex = createDeterministicHexFactory(0xfacaa2);

// Prefix every fixture buffer with deterministic-but-unique bytes so
// sha256 is unique within the test (the UNIQUE(tenant_id, sha256) index
// would otherwise collide between fixtures that share the same fill).
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
    // 10 KiB — well within the 250 KiB cap
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
    // Each file is 160 KiB; first (160 KiB) < cap (250 KiB) → file_part
    // Second (160 KiB) would push to 320 KiB > cap → text_extract.
    // Vary contents so sha256 differs (dedup would otherwise collapse).
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
    const firstSize = 80 * 1024; // 80 KiB — fits in cap
    const bigSize = 200 * 1024; // 200 KiB — when added to 80 KiB = 280 KiB > cap

    const firstContent = uniqueBuffer(firstSize, "C");
    // Distinct fills so each file gets a distinct sha256 (dedup would
    // otherwise collapse rows that share content).
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
    expect(result.blocks[0]!.strategy).toBe("file_part"); // 80 KiB fits
    expect(result.blocks[1]!.strategy).toBe("text_extract"); // 80 + 200 = 280 > 250
    expect(result.blocks[2]!.strategy).toBe("text_extract"); // still over
    expect(result.inline_cap_downgrades).toBe(2);
    expect(result.inline_bytes).toBe(firstSize); // only first file counted as inline
  });
});
