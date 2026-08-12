import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { auditLog, knowledgeChunks } from "../../db/schema/index.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { getKnowledgeSource, listKnowledgeSources } from "../catalog.ts";
import {
  getKnowledgeSourceContent,
  KnowledgeVersionConflictError,
  updateKnowledgeSourceContent,
} from "../content.ts";
import {
  createKnowledgeSource,
  deleteKnowledgeSource,
  ingestKnowledgeSource,
  updateKnowledgeSource,
} from "../service.ts";
import type { KnowledgeSourceView } from "../types.ts";
import { createKnowledgeTestCtx, type KnowledgeTestCtx } from "./setup.ts";

// Requires a real Postgres database — set REQUIRES_PG=0 to skip in environments without a DB.
const skip = process.env.REQUIRES_PG === "0";
const nextUuid = createDeterministicUuidFactory(0x6b10_20);

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
          buffer: Buffer.from(
            "# Compliance\n\nAll payments must include an Idempotency-Key header.\n\n## Audit\n\nRetain logs for 7 years.",
          ),
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
    const list = await listKnowledgeSources({ tenant_id: ctx.tenantId }, ctx.testDb.db);
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
    const source = await getKnowledgeSource(ctx.tenantId, crypto.randomUUID(), ctx.testDb.db); // allow-random: legacy; review before changing
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
        id: crypto.randomUUID(), // allow-random: legacy; review before changing
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
    const _chunksBefore = before!.chunk_count;

    // Re-ingest with different content
    const result = await ingestKnowledgeSource(
      {
        tenant_id: ctx.tenantId,
        knowledge_source_id: createdId,
        upload: {
          buffer: Buffer.from(
            "# New Content\n\nCompletely different material.\n\n## Section 2\n\nMore stuff here.",
          ),
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

  test("Markdown content uses tenant-scoped optimistic concurrency and writes audit", async () => {
    const before = await getKnowledgeSourceContent(ctx.tenantId, createdId, ctx.testDb.db);
    expect(before?.editable).toBe(true);
    expect(before?.documents[0]?.content).toContain("New Content");
    expect(await getKnowledgeSourceContent(nextUuid(), createdId, ctx.testDb.db)).toBeNull();

    const path = before!.documents[0]!.path;
    const updated = await updateKnowledgeSourceContent(
      {
        tenant_id: ctx.tenantId,
        knowledge_source_id: createdId,
        expected_version: before!.version,
        path,
        content: "# Edited policy\n\nOperator-approved content.",
        actor_id: null,
      },
      ctx.testDb.db,
    );
    expect(updated?.version).not.toBe(before!.version);
    expect(updated?.documents[0]?.content).toContain("Operator-approved content");

    await expect(
      updateKnowledgeSourceContent(
        {
          tenant_id: ctx.tenantId,
          knowledge_source_id: createdId,
          expected_version: before!.version,
          path,
          content: "# Stale overwrite",
          actor_id: null,
        },
        ctx.testDb.db,
      ),
    ).rejects.toBeInstanceOf(KnowledgeVersionConflictError);

    const audits = await ctx.testDb.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.resource_id, createdId));
    expect(audits.some((row) => row.action === "knowledge_source.ingested")).toBe(true);
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
    const result = await deleteKnowledgeSource(
      ctx.tenantId,
      crypto.randomUUID(), // allow-random: legacy; review before changing
      null,
      ctx.testDb.db,
    );
    expect(result).toBe(false);
  });

  test("deleteKnowledgeSource returns false for already-deleted", async () => {
    const result = await deleteKnowledgeSource(ctx.tenantId, createdId, null, ctx.testDb.db);
    expect(result).toBe(false);
  });

  // --- tags -------------------------------------------------------------------

  test("createKnowledgeSource persists tags, deduped and capped to 20", async () => {
    // 22 tags (including two case-insensitive dups) → expect 20 unique deduped
    const inputTags = [
      "alpha",
      "beta",
      "gamma",
      "delta",
      "epsilon",
      "zeta",
      "eta",
      "theta",
      "iota",
      "kappa",
      "lambda",
      "mu",
      "nu",
      "xi",
      "omicron",
      "pi",
      "rho",
      "sigma",
      "tau",
      "upsilon",
      "Alpha", // dup of "alpha" (different case)
      "extra", // pushed beyond cap of 20
    ];

    const source = await createKnowledgeSource(
      {
        tenant_id: ctx.tenantId,
        input: { name: "Tagged Source", tags: inputTags, scope: "global" },
        upload: { buffer: Buffer.from("content about tagging"), filename: "tags.txt" },
        actor_id: null,
      },
      ctx.testDb.db,
    );

    // Dedup removes "Alpha" (dup of "alpha"), cap at 20 removes "extra".
    expect(source.tags.length).toBe(20);
    expect(source.tags.includes("alpha")).toBe(true);
    // "Alpha" (dup) must not appear because dedupe keeps first-seen casing
    expect(source.tags.filter((t) => t.toLowerCase() === "alpha").length).toBe(1);
    // "extra" beyond the cap must not appear
    expect(source.tags.includes("extra")).toBe(false);
  });

  test("updateKnowledgeSource replaces tags (no concat — dedup replace semantics)", async () => {
    const source = await createKnowledgeSource(
      {
        tenant_id: ctx.tenantId,
        input: { name: "Tag Replace Source", tags: ["original", "tags"], scope: "global" },
        upload: { buffer: Buffer.from("source with tags to replace"), filename: "replace.txt" },
        actor_id: null,
      },
      ctx.testDb.db,
    );

    expect(source.tags).toEqual(["original", "tags"]);

    // Update with a new set that has a duplicate
    const updated = (await updateKnowledgeSource(
      {
        tenant_id: ctx.tenantId,
        id: source.id,
        patch: { tags: ["new", "new", "set"] },
        actor_id: null,
      },
      ctx.testDb.db,
    )) as KnowledgeSourceView;

    // Must be a replacement — not the union, and deduped
    expect(updated.tags).toEqual(["new", "set"]);
    expect(updated.tags.includes("original")).toBe(false);
  });

  test("updateKnowledgeSource with duplicate tags dedupes case-insensitively", async () => {
    const source = await createKnowledgeSource(
      {
        tenant_id: ctx.tenantId,
        input: { name: "Case Dedupe Source", scope: "global" },
        upload: { buffer: Buffer.from("case dedupe test"), filename: "case.txt" },
        actor_id: null,
      },
      ctx.testDb.db,
    );

    const updated = (await updateKnowledgeSource(
      {
        tenant_id: ctx.tenantId,
        id: source.id,
        patch: { tags: ["Billing", "billing", "BILLING", "api"] },
        actor_id: null,
      },
      ctx.testDb.db,
    )) as KnowledgeSourceView;

    // All three "billing" variants collapse to one (first-seen wins)
    expect(updated.tags.filter((t) => t.toLowerCase() === "billing").length).toBe(1);
    expect(updated.tags).toEqual(["Billing", "api"]);
  });

  test("createKnowledgeSource with no tags produces empty tags array", async () => {
    const source = await createKnowledgeSource(
      {
        tenant_id: ctx.tenantId,
        input: { name: "No Tags Source", scope: "global" },
        upload: { buffer: Buffer.from("no tags"), filename: "notags.txt" },
        actor_id: null,
      },
      ctx.testDb.db,
    );

    expect(source.tags).toEqual([]);
  });
});
