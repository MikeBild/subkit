// C19: Verify the knowledge chunker reads file bytes via the files table
// (knowledge_sources.file_id) rather than the legacy source_uri text.
//
// CONTRACT STATUS: PARTIAL
//
// The schema (`knowledge_sources.file_id`) was shipped in migration 0019.
// However, the knowledge service (`service.ts`) does NOT yet read via
// `file_id` + objectStore.openRead. `createKnowledgeSource` and
// `ingestKnowledgeSource` both accept a caller-supplied `upload.buffer`
// and never consult `files.storage_uri` after the transaction commits.
// The `file_id` foreign key is populated by the migration backfill only
// for pre-existing rows; new rows created by the service leave `file_id`
// NULL because the service does not insert into `files` first.
//
// This test locks the CURRENT behaviour so a future refactor can flip it
// in lockstep:
//   - Test A: createKnowledgeSource with source_type='file_upload' leaves
//     file_id NULL (the gap — service must be wired to insert into `files`
//     and set file_id).
//   - Test B: source_type='url' uses source_uri (working, untouched by
//     migration).
//
// TODO(files): wire knowledge service to insert into `files` table first,
// obtain a file_id, and store it on the knowledge_sources row so the
// chunker can read via objectStore.openRead(files.storage_uri).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
import { files, knowledgeSources } from "../../db/schema/index.ts";
import { createKnowledgeSource } from "../service.ts";
import { createKnowledgeTestCtx, type KnowledgeTestCtx } from "./setup.ts";

const skip = process.env.REQUIRES_PG === "0";

let ctx: KnowledgeTestCtx;

beforeAll(async () => {
  if (skip) return;
  ctx = await createKnowledgeTestCtx("chunker-file-resolve");
}, 60_000);

afterAll(async () => {
  if (!skip && ctx?.cleanup) await ctx.cleanup();
}, 30_000);

describe.skipIf(skip)("C19 — knowledge chunker file resolve", () => {
  test("source_type=file_upload: service creates knowledge_source row (current behaviour: file_id is NULL — gap)", async () => {
    const result = await createKnowledgeSource(
      {
        tenant_id: ctx.tenantId,
        input: { name: "C19 Upload Test", scope: "global" },
        upload: {
          buffer: Buffer.from("# C19\n\nTest content for file resolve gap check."),
          filename: "c19-test.md",
          mime: "text/markdown",
        },
        actor_id: null,
      },
      ctx.testDb.db,
    );

    expect(result.id).toBeDefined();
    expect(result.source_type).toBe("file_upload");

    // Verify the DB row.
    const rows = await ctx.testDb.db
      .select()
      .from(knowledgeSources)
      .where(eq(knowledgeSources.id, result.id));

    expect(rows).toHaveLength(1);
    const ksRow = rows[0]!;

    // TODO(files): this assertion should FAIL after the fix is shipped.
    // Once the service is wired to insert into `files` first, file_id will
    // be non-null and this test must be updated to assert it IS set.
    expect(ksRow.file_id).toBeNull();

    // Confirm no `files` row was inserted for this knowledge source.
    // After the fix, a `files` row should exist and ksRow.file_id should
    // reference it.
    const fileRows = await ctx.testDb.db
      .select()
      .from(files)
      .where(and(eq(files.tenant_id, ctx.tenantId), eq(files.filename, "c19-test.md")));
    expect(fileRows).toHaveLength(0); // gap: no file row written by service
  });

  test("source_type=url: source_uri is canonical reference (untouched by files migration)", async () => {
    const result = await createKnowledgeSource(
      {
        tenant_id: ctx.tenantId,
        input: { name: "C19 URL Test", scope: "global" },
        upload: {
          buffer: Buffer.from("# URL content\n\nSome external documentation."),
          filename: "https://example.com/docs.md",
          mime: "text/markdown",
        },
        source_type_override: "url",
        source_uri_override: "https://example.com/docs.md",
        actor_id: null,
      },
      ctx.testDb.db,
    );

    expect(result.source_type).toBe("url");
    expect(result.source_uri).toBe("https://example.com/docs.md");

    // URL sources must NEVER get a file_id — they read through source_uri.
    const rows = await ctx.testDb.db
      .select()
      .from(knowledgeSources)
      .where(eq(knowledgeSources.id, result.id));

    expect(rows).toHaveLength(1);
    expect(rows[0]!.file_id).toBeNull();
    expect(rows[0]!.source_uri).toBe("https://example.com/docs.md");
  });

  test("tenant isolation: source_type=file_upload not visible from wrong tenant", async () => {
    // Create a source under tenantId.
    const result = await createKnowledgeSource(
      {
        tenant_id: ctx.tenantId,
        input: { name: "C19 Tenant Isolation", scope: "global" },
        upload: {
          buffer: Buffer.from("# Tenant isolation test"),
          filename: "isolation.md",
          mime: "text/markdown",
        },
        actor_id: null,
      },
      ctx.testDb.db,
    );

    // Query from a different (non-existent) tenant — must return nothing.
    const wrongTenantRows = await ctx.testDb.db
      .select()
      .from(knowledgeSources)
      .where(
        and(
          eq(knowledgeSources.tenant_id, "00000000-0000-0000-0000-000000000000"),
          eq(knowledgeSources.id, result.id),
          isNull(knowledgeSources.deleted_at),
        ),
      );

    expect(wrongTenantRows).toHaveLength(0);
  });
});
