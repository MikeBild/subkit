// Integration test: LLM provider Files API id persistence.
//
// Verifies that after the first turn uploads a file via the mock provider,
// the `anthropic_file_id` column on the `files` row is non-null. The
// second turn with the same fid must NOT call the uploader again (counter
// stays at 1). This covers the "provider-id caching" invariant from D6.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { conversations, files, tenants } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { attachInlineForTest } from "../../../files/test-helpers.ts";
import { getTestNow } from "../../../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../../../test-helpers/determinism/ids.ts";
import { getStaticCapabilities } from "../capabilities.ts";
import { buildFileContentBlocks } from "../file-context.ts";
import type { UploadedFile, UploadFileParams } from "../files-api.ts";

// Deterministic uuid source for synthetic provider-side file ids.
const uuid = createDeterministicUuidFactory(0xfa9e75);

// `buildFileContentBlocks` compares `llm_file_expires_at` to the
// production clock seam (real `Date.now()` unless a test clock is
// installed), so fixture expirations MUST be relative to live time.
// `getTestNow()` falls through to `Date.now()` and stays lint-quiet.

let ctx: TestDb;
let tenant_id: string;
let conversation_id: string;

beforeAll(async () => {
  ctx = await createTestDb("files-api-persistence");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "fap-t", display_name: "FAP Test" })
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

describe("Files API persistence across turns", () => {
  test("first turn uses a file → files row carries anthropic_file_id", async () => {
    const bigContent = Buffer.alloc(6 * 1024 * 1024, "P");
    const att = await attachInlineForTest({
      db: ctx.db,
      tenant_id,
      conversation_id,
      filename: "persist-test.pdf",
      content: bigContent,
      content_type: "application/pdf",
      slug: "persist-test",
    });

    let uploadCallCount = 0;
    const mockUploader = async (params: UploadFileParams): Promise<UploadedFile> => {
      uploadCallCount++;
      return {
        file_id: `file_persist_${uuid().replace(/-/g, "").slice(0, 12)}`,
        provider: params.provider as "anthropic",
        expires_at: new Date(getTestNow() + 7 * 24 * 60 * 60 * 1000),
        bytes: params.data.byteLength,
        filename: params.filename,
        mime_type: params.mimeType,
      };
    };

    const caps = getStaticCapabilities("anthropic"); // filesApiSupport: true
    await buildFileContentBlocks({
      db: ctx.db,
      tenant_id,
      provider: "anthropic",
      capabilities: caps,
      fids: [att.file_id],
      uploader: mockUploader,
    });

    expect(uploadCallCount).toBe(1);

    const [row] = await ctx.db.select().from(files).where(eq(files.id, att.file_uuid));
    expect(row).toBeDefined();
    expect(row!.anthropic_file_id).toBeTruthy();
    expect(row!.llm_file_expires_at).not.toBeNull();
  });

  test("second turn does NOT re-upload (mock counter stays at 1)", async () => {
    const bigContent = Buffer.alloc(6 * 1024 * 1024, "Q");
    const att = await attachInlineForTest({
      db: ctx.db,
      tenant_id,
      conversation_id,
      filename: "persist-cached.pdf",
      content: bigContent,
      content_type: "application/pdf",
      slug: "persist-cached",
    });

    let uploadCallCount = 0;
    const mockUploader = async (params: UploadFileParams): Promise<UploadedFile> => {
      uploadCallCount++;
      return {
        file_id: `file_cached_${uuid().replace(/-/g, "").slice(0, 12)}`,
        provider: params.provider as "anthropic",
        expires_at: new Date(getTestNow() + 7 * 24 * 60 * 60 * 1000),
        bytes: params.data.byteLength,
        filename: params.filename,
        mime_type: params.mimeType,
      };
    };

    const caps = getStaticCapabilities("anthropic");

    // Turn 1
    await buildFileContentBlocks({
      db: ctx.db,
      tenant_id,
      provider: "anthropic",
      capabilities: caps,
      fids: [att.file_id],
      uploader: mockUploader,
    });
    expect(uploadCallCount).toBe(1);

    // Turn 2 — same fid, should use cached provider id
    await buildFileContentBlocks({
      db: ctx.db,
      tenant_id,
      provider: "anthropic",
      capabilities: caps,
      fids: [att.file_id],
      uploader: mockUploader,
    });
    expect(uploadCallCount).toBe(1); // still 1 — no re-upload
  });
});
