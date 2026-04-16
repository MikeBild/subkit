import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { auditLog, knowledgeChunks, knowledgeSources } from "../../db/schema/index.ts";
import {
  createKnowledgeSource,
  deleteKnowledgeSource,
  getKnowledgeSource,
  ingestKnowledgeSource,
  listKnowledgeSources,
  updateKnowledgeSource,
} from "../service.ts";
import { createKnowledgeTestCtx, type KnowledgeTestCtx } from "./setup.ts";

const skip = process.env.SKIP_DB_TESTS === "1";

let ctx: KnowledgeTestCtx;

beforeAll(async () => {
  if (skip) return;
  ctx = await createKnowledgeTestCtx("svc");
}, 60_000);

afterAll(async () => {
  if (!skip && ctx?.cleanup) await ctx.cleanup();
}, 30_000);

describe.skipIf(skip)("knowledge/service", () => {
  let createdId: string;

  test("createKnowledgeSource persists source + chunks + audit", async () => {
    const result = await createKnowledgeSource(
      {
        tenant_id: ctx.tenantId,
        input: {
          name: "Compliance Policy",
          scope: "global",
        },
        upload: {
          buffer: Buffer.from("# Compliance\n\nAll payments must include an Idempotency-Key header.\n\n## Audit\n\nRetain logs for 7 years."),
          filename: "compliance.md",
          mime: "text/markdown",
        },
        actor_id: null,
      },
      ctx.testDb.db,
    );

    expect(result.id).toBeDefined();
    expect(result.name).toBe("Compliance Policy");
    expect(result.slug).toBe("compliance-policy");
    expect(result.scope).toBe("global");
    expect(result.status).toBe("active");
    expect(result.chunk_count).toBeGreaterThan(0);
    expect(result.bytes_total).toBeGreaterThan(0);
    createdId = result.id;

    // Verify chunks persisted
    const chunks = await ctx.testDb.db
      .select()
      .from(knowledgeChunks)
      .where(eq(knowledgeChunks.knowledge_source_id, createdId));
    expect(chunks.length).toBe(result.chunk_count);
    expect(chunks.every((c) => c.fingerprint.length > 0)).toBe(true);

    // Verify audit
    const audits = await ctx.testDb.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.resource_id, createdId));
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(audits.some((a) => a.action === "knowledge_source.created")).toBe(true);
  });

  test("listKnowledgeSources returns active sources", async () => {
    const list = await listKnowledgeSources(
      { tenant_id: ctx.tenantId },
      ctx.testDb.db,
    );
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list.find((s) => s.id === createdId)).toBeDefined();
  });

  test("listKnowledgeSources filters by scope", async () => {
    const global = await listKnowledgeSources(
      { tenant_id: ctx.tenantId, scope: "global" },
      ctx.testDb.db,
    );
    expect(global.find((s) => s.id === createdId)).toBeDefined();

    const workflow = await listKnowledgeSources(
      { tenant_id: ctx.tenantId, scope: "workflow" },
      ctx.testDb.db,
    );
    expect(workflow.find((s) => s.id === createdId)).toBeUndefined();
  });

  test("getKnowledgeSource returns source by id", async () => {
    const source = await getKnowledgeSource(ctx.tenantId, createdId, ctx.testDb.db);
    expect(source).not.toBeNull();
    expect(source!.id).toBe(createdId);
    expect(source!.name).toBe("Compliance Policy");
  });

  test("getKnowledgeSource returns null for non-existent id", async () => {
    const source = await getKnowledgeSource(ctx.tenantId, crypto.randomUUID(), ctx.testDb.db);
    expect(source).toBeNull();
  });

  test("updateKnowledgeSource updates metadata", async () => {
    const updated = await updateKnowledgeSource(
      {
        tenant_id: ctx.tenantId,
        id: createdId,
        patch: { name: "Updated Compliance", description: "Updated description" },
        actor_id: null,
      },
      ctx.testDb.db,
    );
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe("Updated Compliance");
    expect(updated!.description).toBe("Updated description");
  });

  test("updateKnowledgeSource returns null for non-existent id", async () => {
    const result = await updateKnowledgeSource(
      {
        tenant_id: ctx.tenantId,
        id: crypto.randomUUID(),
        patch: { name: "nope" },
        actor_id: null,
      },
      ctx.testDb.db,
    );
    expect(result).toBeNull();
  });

  test("createKnowledgeSource with workflow scope requires workflow_id", async () => {
    expect(
      createKnowledgeSource(
        {
          tenant_id: ctx.tenantId,
          input: { name: "Bad Scope", scope: "workflow" },
          upload: { buffer: Buffer.from("hello"), filename: "test.txt" },
          actor_id: null,
        },
        ctx.testDb.db,
      ),
    ).rejects.toThrow("workflow_id is required");
  });

  test("createKnowledgeSource with workflow scope succeeds with workflow_id", async () => {
    const result = await createKnowledgeSource(
      {
        tenant_id: ctx.tenantId,
        input: {
          name: "Workflow Runbook",
          scope: "workflow",
          workflow_id: ctx.workflowId,
        },
        upload: { buffer: Buffer.from("Step 1: Do the thing"), filename: "runbook.txt" },
        actor_id: null,
      },
      ctx.testDb.db,
    );
    expect(result.scope).toBe("workflow");
    expect(result.workflow_id).toBe(ctx.workflowId);
  });

  test("ingestKnowledgeSource replaces chunks", async () => {
    // Get current chunk count
    const before = await getKnowledgeSource(ctx.tenantId, createdId, ctx.testDb.db);
    expect(before).not.toBeNull();
    const chunksBefore = before!.chunk_count;

    // Re-ingest with different content
    const result = await ingestKnowledgeSource(
      {
        tenant_id: ctx.tenantId,
        knowledge_source_id: createdId,
        upload: {
          buffer: Buffer.from("# New Content\n\nCompletely different material.\n\n## Section 2\n\nMore stuff here."),
          filename: "compliance-v2.md",
          mime: "text/markdown",
        },
        actor_id: null,
      },
      ctx.testDb.db,
    );

    expect(result.ingested_count).toBeGreaterThan(0);

    // Verify old chunks were replaced
    const after = await getKnowledgeSource(ctx.tenantId, createdId, ctx.testDb.db);
    expect(after).not.toBeNull();
    // Version should have changed
    expect(after!.version).not.toBe(before!.version);
  });

  test("deleteKnowledgeSource soft-deletes", async () => {
    const deleted = await deleteKnowledgeSource(ctx.tenantId, createdId, null, ctx.testDb.db);
    expect(deleted).toBe(true);

    // Should no longer appear in get
    const after = await getKnowledgeSource(ctx.tenantId, createdId, ctx.testDb.db);
    expect(after).toBeNull();

    // Should no longer appear in list
    const list = await listKnowledgeSources({ tenant_id: ctx.tenantId }, ctx.testDb.db);
    expect(list.find((s) => s.id === createdId)).toBeUndefined();

    // Audit should record the delete
    const audits = await ctx.testDb.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.resource_id, createdId));
    expect(audits.some((a) => a.action === "knowledge_source.deleted")).toBe(true);
  });

  test("deleteKnowledgeSource returns false for non-existent", async () => {
    const result = await deleteKnowledgeSource(ctx.tenantId, crypto.randomUUID(), null, ctx.testDb.db);
    expect(result).toBe(false);
  });

  test("deleteKnowledgeSource returns false for already-deleted", async () => {
    const result = await deleteKnowledgeSource(ctx.tenantId, createdId, null, ctx.testDb.db);
    expect(result).toBe(false);
  });
});
