// LLM file-context: binary text_extract branch.
//
// Asserts that PDF / DOCX / XLSX / PPTX attachments routed through the
// `text_extract` strategy run through the binary parser registry and
// produce a populated, non-placeholder text block. Same harness as the
// per-turn cap test — uses the in-process file resolver and a fake
// uploader that should never be called.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { conversations, tenants } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import {
  buildDocxFixture,
  buildPdfFixture,
  buildPptxFixture,
  buildXlsxFixture,
} from "../../../docs-ingestion/parsers/fixtures.test-helper.ts";
import { attachInlineForTest } from "../../../files/test-helpers.ts";
import { createDeterministicUuidFactory } from "../../../test-helpers/determinism/ids.ts";
import { getStaticCapabilities } from "../capabilities.ts";
import { buildFileContentBlocks } from "../file-context.ts";
import type { UploadFileParams } from "../files-api.ts";

const uuid = createDeterministicUuidFactory(0xb1c0a1);

let ctx: TestDb;
let tenant_id: string;
let conversation_id: string;

beforeAll(async () => {
  ctx = await createTestDb("text-extract-binary");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "tx-bin-t", display_name: "Text Extract Binary" })
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

// Capabilities that force text_extract: no Files API and small enough
// per-file ceiling that file_part is skipped — keeps the test focused
// on the binary parsing branch.
function forceTextExtractCaps() {
  return {
    ...getStaticCapabilities("mock"),
    supportsFile: false,
    filesApiSupport: false,
    maxFileSizeMB: 0,
  };
}

const noopUploader = (async (_: UploadFileParams) => {
  throw new Error("uploader should not be called on text_extract branch");
}) as never;

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
      provider: "mock",
      capabilities: forceTextExtractCaps(),
      fids: [att.file_id],
      uploader: noopUploader,
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
      provider: "mock",
      capabilities: forceTextExtractCaps(),
      fids: [att.file_id],
      uploader: noopUploader,
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
      provider: "mock",
      capabilities: forceTextExtractCaps(),
      fids: [att.file_id],
      uploader: noopUploader,
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
      provider: "mock",
      capabilities: forceTextExtractCaps(),
      fids: [att.file_id],
      uploader: noopUploader,
    });
    const block = result.blocks[0]!;
    if (block.strategy !== "text_extract") throw new Error("expected text_extract");
    expect(block.placeholder).toBe(false);
    expect(block.text).toContain("Alpha");
    expect(block.text).toContain("Bravo");
  });
});
