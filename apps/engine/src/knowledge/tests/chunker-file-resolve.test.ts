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
  test("source_type=file_upload: service persists a files row and sets file_id", async () => {
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

    const rows = await ctx.testDb.db
      .select()
      .from(knowledgeSources)
      .where(eq(knowledgeSources.id, result.id));

    expect(rows).toHaveLength(1);
    const ksRow = rows[0]!;

    expect(ksRow.file_id).not.toBeNull();

    const fileRows = await ctx.testDb.db
      .select()
      .from(files)
      .where(and(eq(files.tenant_id, ctx.tenantId), eq(files.filename, "c19-test.md")));
    expect(fileRows).toHaveLength(1);
    expect(fileRows[0]!.id).toBe(ksRow.file_id as string);
    expect(fileRows[0]!.storage_uri.length).toBeGreaterThan(0);
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

    const rows = await ctx.testDb.db
      .select()
      .from(knowledgeSources)
      .where(eq(knowledgeSources.id, result.id));

    expect(rows).toHaveLength(1);
    expect(rows[0]!.file_id).toBeNull();
    expect(rows[0]!.source_uri).toBe("https://example.com/docs.md");
  });

  test("tenant isolation: source_type=file_upload not visible from wrong tenant", async () => {
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
