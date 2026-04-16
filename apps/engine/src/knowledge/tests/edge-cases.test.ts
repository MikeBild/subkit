import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { KNOWLEDGE_SOURCE_MAX_BYTES, KnowledgeBudgetExceededError } from "../budgets.ts";
import {
  createKnowledgeSource,
  deleteKnowledgeSource,
  searchKnowledge,
  updateKnowledgeSource,
} from "../service.ts";
import { createKnowledgeTestCtx, type KnowledgeTestCtx } from "./setup.ts";

const skip = process.env.SKIP_DB_TESTS === "1";

let ctx: KnowledgeTestCtx;

beforeAll(async () => {
  if (skip) return;
  ctx = await createKnowledgeTestCtx("edge");
}, 60_000);

afterAll(async () => {
  if (!skip && ctx?.cleanup) await ctx.cleanup();
}, 30_000);

describe.skipIf(skip)("knowledge/edge-cases", () => {
  test("upload empty file (0 bytes) creates source with 0 chunks", async () => {
    const result = await createKnowledgeSource(
      {
        tenant_id: ctx.tenantId,
        input: { name: "Empty File" },
        upload: { buffer: Buffer.from(""), filename: "empty.txt" },
        actor_id: null,
      },
      ctx.testDb.db,
    );
    expect(result.chunk_count).toBe(0);
    expect(result.bytes_total).toBe(0);
    expect(result.status).toBe("active");
  });

  test("upload file with only whitespace creates minimal chunks", async () => {
    const result = await createKnowledgeSource(
      {
        tenant_id: ctx.tenantId,
        input: { name: "Whitespace" },
        upload: { buffer: Buffer.from("   \n\n   \n   "), filename: "whitespace.txt" },
        actor_id: null,
      },
      ctx.testDb.db,
    );
    // Whitespace-only content may produce 0 chunks after filtering
    expect(result.status).toBe("active");
  });

  test("search with SQL-special characters is safe", async () => {
    // plainto_tsquery normalizes these
    const queries = ["a & b", "a | b", "!negation", ":* prefix", "test's \"quotes\""];
    for (const q of queries) {
      const hits = await searchKnowledge(
        { tenant_id: ctx.tenantId, query: q },
        ctx.testDb.db,
      );
      // Should not throw — empty results are fine
      expect(Array.isArray(hits)).toBe(true);
    }
  });

  test("create with duplicate slug fails", async () => {
    await createKnowledgeSource(
      {
        tenant_id: ctx.tenantId,
        input: { name: "Unique Doc", slug: "unique-slug" },
        upload: { buffer: Buffer.from("content"), filename: "unique.txt" },
        actor_id: null,
      },
      ctx.testDb.db,
    );

    expect(
      createKnowledgeSource(
        {
          tenant_id: ctx.tenantId,
          input: { name: "Duplicate Doc", slug: "unique-slug" },
          upload: { buffer: Buffer.from("other"), filename: "dup.txt" },
          actor_id: null,
        },
        ctx.testDb.db,
      ),
    ).rejects.toThrow();
  });

  test("update scope to workflow without workflow_id fails", async () => {
    const source = await createKnowledgeSource(
      {
        tenant_id: ctx.tenantId,
        input: { name: "Scope Change Test" },
        upload: { buffer: Buffer.from("data"), filename: "scope.txt" },
        actor_id: null,
      },
      ctx.testDb.db,
    );

    expect(
      updateKnowledgeSource(
        {
          tenant_id: ctx.tenantId,
          id: source.id,
          patch: { scope: "workflow" },
          actor_id: null,
        },
        ctx.testDb.db,
      ),
    ).rejects.toThrow("workflow_id is required");
  });

  test("delete already-deleted source returns false", async () => {
    const source = await createKnowledgeSource(
      {
        tenant_id: ctx.tenantId,
        input: { name: "Delete Twice" },
        upload: { buffer: Buffer.from("data"), filename: "del.txt" },
        actor_id: null,
      },
      ctx.testDb.db,
    );

    const first = await deleteKnowledgeSource(ctx.tenantId, source.id, null, ctx.testDb.db);
    expect(first).toBe(true);

    const second = await deleteKnowledgeSource(ctx.tenantId, source.id, null, ctx.testDb.db);
    expect(second).toBe(false);
  });

  test("search with very long query is truncated and safe", async () => {
    const longQuery = "a".repeat(1000);
    const hits = await searchKnowledge(
      { tenant_id: ctx.tenantId, query: longQuery },
      ctx.testDb.db,
    );
    expect(Array.isArray(hits)).toBe(true);
  });
});
