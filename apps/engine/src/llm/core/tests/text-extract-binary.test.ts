import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { conversations } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { attachInlineForTest } from "../../../files/test-helpers.ts";
import {
  buildDocxFixture,
  buildPdfFixture,
  buildPptxFixture,
  buildXlsxFixture,
} from "../../../test-helpers/binary-fixtures.ts";
import { createDeterministicUuidFactory } from "../../../test-helpers/determinism/ids.ts";
import { seedTenant } from "../../../test-helpers/seed.ts";
import { getStaticCapabilities } from "../capabilities.ts";
import { buildFileContentBlocks } from "../file-context.ts";

const uuid = createDeterministicUuidFactory(0xb1c0a1);

let ctx: TestDb;
let tenant_id: string;
let conversation_id: string;

beforeAll(async () => {
  ctx = await createTestDb("text-extract-binary");
  const t = await seedTenant(ctx.db, { slug: "tx-bin-t", display_name: "Text Extract Binary" });
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

function forceTextExtractCaps() {
  return {
    ...getStaticCapabilities("mock"),
    supportsFile: false,
    maxFileSizeMB: 0,
  };
}

describe("text_extract binary branch", () => {
  test("pdf attachment → text_extract with parsed text", async () => {
    const pdf = buildPdfFixture("Hello LLM binary path.");
    const att = await attachInlineForTest({
      db: ctx.db,
      tenant_id,
      conversation_id,
      filename: "sample.pdf",
      content: pdf,
      content_type: "application/pdf",
      slug: `pdf-${uuid().slice(0, 8)}`,
    });
    const result = await buildFileContentBlocks({
      db: ctx.db,
      tenant_id,
      capabilities: forceTextExtractCaps(),
      fids: [att.file_id],
    });
    expect(result.blocks).toHaveLength(1);
    const block = result.blocks[0]!;
    expect(block.strategy).toBe("text_extract");
    if (block.strategy !== "text_extract") throw new Error("unreachable");
    expect(block.placeholder).toBe(false);
    expect(block.text).toContain("Hello LLM binary path");
  });

  test("docx attachment → text_extract with markdown body", async () => {
    const docx = await buildDocxFixture("LLM Heading", "Body paragraph for LLM.");
    const att = await attachInlineForTest({
      db: ctx.db,
      tenant_id,
      conversation_id,
      filename: "sample.docx",
      content: docx,
      content_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      slug: `docx-${uuid().slice(0, 8)}`,
    });
    const result = await buildFileContentBlocks({
      db: ctx.db,
      tenant_id,
      capabilities: forceTextExtractCaps(),
      fids: [att.file_id],
    });
    const block = result.blocks[0]!;
    if (block.strategy !== "text_extract") throw new Error("expected text_extract");
    expect(block.placeholder).toBe(false);
    expect(block.text).toMatch(/LLM Heading/);
    expect(block.text).toMatch(/Body paragraph for LLM/);
  });

  test("xlsx attachment → text_extract with sheet JSON", async () => {
    const xlsx = buildXlsxFixture({
      Sheet1: [
        { id: 1, name: "carol" },
        { id: 2, name: "dave" },
      ],
    });
    const att = await attachInlineForTest({
      db: ctx.db,
      tenant_id,
      conversation_id,
      filename: "sample.xlsx",
      content: xlsx,
      content_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      slug: `xlsx-${uuid().slice(0, 8)}`,
    });
    const result = await buildFileContentBlocks({
      db: ctx.db,
      tenant_id,
      capabilities: forceTextExtractCaps(),
      fids: [att.file_id],
    });
    const block = result.blocks[0]!;
    if (block.strategy !== "text_extract") throw new Error("expected text_extract");
    expect(block.placeholder).toBe(false);
    expect(block.text).toContain("carol");
  });

  test("pptx attachment → text_extract with per-slide text", async () => {
    const pptx = await buildPptxFixture(["Alpha", "Bravo"]);
    const att = await attachInlineForTest({
      db: ctx.db,
      tenant_id,
      conversation_id,
      filename: "sample.pptx",
      content: pptx,
      content_type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      slug: `pptx-${uuid().slice(0, 8)}`,
    });
    const result = await buildFileContentBlocks({
      db: ctx.db,
      tenant_id,
      capabilities: forceTextExtractCaps(),
      fids: [att.file_id],
    });
    const block = result.blocks[0]!;
    if (block.strategy !== "text_extract") throw new Error("expected text_extract");
    expect(block.placeholder).toBe(false);
    expect(block.text).toContain("Alpha");
    expect(block.text).toContain("Bravo");
  });
});
