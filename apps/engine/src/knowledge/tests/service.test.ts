import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import {
  auditLog,
  events,
  knowledgeChunks,
  knowledgeSources,
  knowledgeSourceVersions,
} from "../../db/schema/index.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { upsertKnowledgeBundle } from "../bundle-service.ts";
import { getKnowledgeSource, knowledgeSourceTotals, listKnowledgeSources } from "../catalog.ts";
import {
  getKnowledgeSourceContent,
  KnowledgeVersionConflictError,
  updateKnowledgeSourceContent,
} from "../content.ts";
import {
  KnowledgeSourceAddressConflictError,
  KnowledgeSourceAddressReadOnlyError,
} from "../errors.ts";
import {
  createKnowledgeSource,
  deleteKnowledgeSource,
  ingestKnowledgeSource,
  updateKnowledgeSource,
} from "../service.ts";
import type { KnowledgeSourceView } from "../types.ts";
import { createKnowledgeTestCtx, type KnowledgeTestCtx } from "./setup.ts";

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
        actor: null,
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

    const chunks = await ctx.testDb.db
      .select()
      .from(knowledgeChunks)
      .where(eq(knowledgeChunks.knowledge_source_id, createdId));
    expect(chunks.length).toBe(result.chunk_count);
    expect(chunks.every((c) => c.fingerprint.length > 0)).toBe(true);

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

  test("source and section totals share filters and cover more than the requested page", async () => {
    await ctx.testDb.db.insert(knowledgeSources).values(
      [3, 7, 100].map((count, index) => ({
        tenant_id: ctx.tenantId,
        name: `Section totals ${index}`,
        slug: `section-totals-${index}`,
        source_type: "inline",
        source_uri: `section-totals-${index}.md`,
        version: `content-${index}`,
        status: index === 2 ? ("inactive" as const) : ("active" as const),
        chunk_count: count,
      })),
    );
    const params = { tenant_id: ctx.tenantId, q: "section-totals", status: "active" as const };
    const page = await listKnowledgeSources({ ...params, limit: 1, offset: 1 }, ctx.testDb.db);
    expect(page).toHaveLength(1);
    expect(await knowledgeSourceTotals(params, ctx.testDb.db)).toEqual({
      total: 2,
      sections_total: 10,
    });
    expect(
      await knowledgeSourceTotals({ ...params, tenant_id: nextUuid() }, ctx.testDb.db),
    ).toEqual({ total: 0, sections_total: 0 });
    expect(
      await knowledgeSourceTotals({ ...params, q: "missing-section-totals" }, ctx.testDb.db),
    ).toEqual({ total: 0, sections_total: 0 });
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

  test("address changes preserve content and prevent a stale refresh from restoring the old address", async () => {
    const originalAddress = "https://example.com/original.md";
    const nextAddress = "https://example.com/replacement.md";
    const source = await createKnowledgeSource(
      {
        tenant_id: ctx.tenantId,
        input: { name: "Address update", scope: "global" },
        upload: {
          buffer: Buffer.from("# Original address content"),
          filename: originalAddress,
          mime: "text/markdown",
        },
        actor: null,
        source_type_override: "url",
        source_uri_override: originalAddress,
      },
      ctx.testDb.db,
    );
    const changed = await updateKnowledgeSource(
      {
        tenant_id: ctx.tenantId,
        id: source.id,
        patch: { source_uri: nextAddress },
        actor_id: null,
      },
      ctx.testDb.db,
    );
    expect(changed?.source_uri).toBe(nextAddress);
    expect(changed?.version).toBe(source.version);
    await expect(
      ingestKnowledgeSource(
        {
          tenant_id: ctx.tenantId,
          knowledge_source_id: source.id,
          expected_source_uri: originalAddress,
          upload: {
            buffer: Buffer.from("# Outdated refresh"),
            filename: originalAddress,
            mime: "text/markdown",
          },
          actor: null,
        },
        ctx.testDb.db,
      ),
    ).rejects.toBeInstanceOf(KnowledgeSourceAddressConflictError);
    const after = await getKnowledgeSource(ctx.tenantId, source.id, ctx.testDb.db);
    expect(after?.source_uri).toBe(nextAddress);
    expect(after?.version).toBe(source.version);
    await expect(
      updateKnowledgeSource(
        {
          tenant_id: ctx.tenantId,
          id: createdId,
          patch: { source_uri: nextAddress },
          actor_id: null,
        },
        ctx.testDb.db,
      ),
    ).rejects.toBeInstanceOf(KnowledgeSourceAddressReadOnlyError);
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
          actor: null,
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
        actor: null,
      },
      ctx.testDb.db,
    );
    expect(result.scope).toBe("workflow");
    expect(result.workflow_id).toBe(ctx.workflowId);
  });

  test("ingestKnowledgeSource replaces chunks", async () => {
    const before = await getKnowledgeSource(ctx.tenantId, createdId, ctx.testDb.db);
    expect(before).not.toBeNull();
    const _chunksBefore = before!.chunk_count;

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
        actor: null,
      },
      ctx.testDb.db,
    );

    expect(result.ingested_count).toBeGreaterThan(0);

    const after = await getKnowledgeSource(ctx.tenantId, createdId, ctx.testDb.db);
    expect(after).not.toBeNull();
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
        note: "Clarified the approved policy",
        actor: null,
      },
      ctx.testDb.db,
    );
    expect(updated?.version).not.toBe(before!.version);
    expect(updated?.documents[0]?.content).toContain("Operator-approved content");
    const notes = await ctx.testDb.db
      .select({ note: knowledgeSourceVersions.note })
      .from(knowledgeSourceVersions)
      .where(
        and(
          eq(knowledgeSourceVersions.tenant_id, ctx.tenantId),
          eq(knowledgeSourceVersions.knowledge_source_id, createdId),
          eq(knowledgeSourceVersions.content_hash, updated!.version),
        ),
      );
    expect(notes).toEqual([{ note: "Clarified the approved policy" }]);

    await expect(
      updateKnowledgeSourceContent(
        {
          tenant_id: ctx.tenantId,
          knowledge_source_id: createdId,
          expected_version: before!.version,
          path,
          content: "# Stale overwrite",
          actor: null,
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

  test("editing either end of a full bundle preserves every other document", async () => {
    const files = Array.from({ length: 500 }, (_, index) => ({
      path: `/document-${String(index).padStart(3, "0")}.md`,
      content: `# Document ${index}\n\nDistinct content for document ${index}.`,
    }));
    const created = await upsertKnowledgeBundle(
      {
        tenant_id: ctx.tenantId,
        actor: null,
        input: { name: "Complete editable bundle" },
        files,
      },
      ctx.testDb.db,
    );
    const sourceId = created.knowledge_source.id;
    const before = await getKnowledgeSourceContent(ctx.tenantId, sourceId, ctx.testDb.db);
    if (!before) throw new Error("bundle content missing");
    expect(before.documents).toEqual(files);
    const foreignTenant = nextUuid();
    expect(await getKnowledgeSourceContent(foreignTenant, sourceId, ctx.testDb.db)).toBeNull();
    expect(
      await updateKnowledgeSourceContent(
        {
          tenant_id: foreignTenant,
          knowledge_source_id: sourceId,
          expected_version: before.version,
          path: "/document-000.md",
          content: "# Foreign overwrite",
          actor: null,
        },
        ctx.testDb.db,
      ),
    ).toBeNull();
    let current = before;
    let expected = files;
    for (const path of ["/document-000.md", "/document-499.md"]) {
      const content = `# Reviewed document\n\nReplacement for ${path}.`;
      const updated = await updateKnowledgeSourceContent(
        {
          tenant_id: ctx.tenantId,
          knowledge_source_id: sourceId,
          expected_version: current.version,
          path,
          content,
          actor: null,
        },
        ctx.testDb.db,
      );
      if (!updated) throw new Error("bundle update missing");
      expected = expected.map((document) =>
        document.path === path ? { ...document, content } : document,
      );
      expect(updated.version).not.toBe(current.version);
      expect(updated.documents).toEqual(expected);
      expect((await getKnowledgeSource(ctx.tenantId, sourceId, ctx.testDb.db))?.chunk_count).toBe(
        500,
      );
      expect(
        (await getKnowledgeSourceContent(ctx.tenantId, sourceId, ctx.testDb.db))?.documents,
      ).toEqual(expected);
      current = updated;
    }
    await expect(
      updateKnowledgeSourceContent(
        {
          tenant_id: ctx.tenantId,
          knowledge_source_id: sourceId,
          expected_version: before.version,
          path: "/document-499.md",
          content: "# Stale overwrite",
          actor: null,
        },
        ctx.testDb.db,
      ),
    ).rejects.toBeInstanceOf(KnowledgeVersionConflictError);
    expect(
      (await getKnowledgeSourceContent(ctx.tenantId, sourceId, ctx.testDb.db))?.documents,
    ).toEqual(expected);
  });

  test("Markdown content reads and preserves every section beyond the former page boundary", async () => {
    const content = Array.from(
      { length: 205 },
      (_, index) => `## Section ${index}\n\nDistinct source material for section ${index}.`,
    ).join("\n\n");
    const created = await createKnowledgeSource(
      {
        tenant_id: ctx.tenantId,
        actor: null,
        input: { name: "Complete editable Markdown" },
        upload: { buffer: Buffer.from(content), filename: "complete.md", mime: "text/markdown" },
      },
      ctx.testDb.db,
    );
    expect(created.chunk_count).toBe(205);
    const before = await getKnowledgeSourceContent(ctx.tenantId, created.id, ctx.testDb.db);
    if (!before) throw new Error("Markdown content missing");
    expect(before.documents).toEqual([{ path: "complete.md", content }]);
    const edited = content.replace(
      "Distinct source material for section 0.",
      "Reviewed source material for section 0.",
    );
    const updated = await updateKnowledgeSourceContent(
      {
        tenant_id: ctx.tenantId,
        knowledge_source_id: created.id,
        expected_version: before.version,
        path: "complete.md",
        content: edited,
        actor: null,
      },
      ctx.testDb.db,
    );
    expect(updated?.documents).toEqual([{ path: "complete.md", content: edited }]);
    expect((await getKnowledgeSource(ctx.tenantId, created.id, ctx.testDb.db))?.chunk_count).toBe(
      205,
    );
  });

  test("deleteKnowledgeSource soft-deletes", async () => {
    const deleted = await deleteKnowledgeSource(ctx.tenantId, createdId, null, ctx.testDb.db);
    expect(deleted).toBe(true);

    const after = await getKnowledgeSource(ctx.tenantId, createdId, ctx.testDb.db);
    expect(after).toBeNull();

    const list = await listKnowledgeSources({ tenant_id: ctx.tenantId }, ctx.testDb.db);
    expect(list.find((s) => s.id === createdId)).toBeUndefined();

    const audits = await ctx.testDb.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.resource_id, createdId));
    expect(audits.some((a) => a.action === "knowledge_source.deleted")).toBe(true);
  });

  test("each write of the source announces a knowledge list change in its transaction", async () => {
    const announced = await ctx.testDb.db
      .select({ type: events.type })
      .from(events)
      .where(
        and(
          eq(events.tenant_id, ctx.tenantId),
          eq(events.channel, "resource.lifecycle"),
          sql`${events.payload}->>'knowledge_source_id' = ${createdId}`,
        ),
      );
    expect(announced.length).toBeGreaterThanOrEqual(4);
    expect(new Set(announced.map((row) => row.type))).toEqual(
      new Set(["knowledge_source.changed"]),
    );
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

  test("createKnowledgeSource persists tags, deduped and capped to 20", async () => {
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
      "Alpha",
      "extra",
    ];

    const source = await createKnowledgeSource(
      {
        tenant_id: ctx.tenantId,
        input: { name: "Tagged Source", tags: inputTags, scope: "global" },
        upload: { buffer: Buffer.from("content about tagging"), filename: "tags.txt" },
        actor: null,
      },
      ctx.testDb.db,
    );

    expect(source.tags.length).toBe(20);
    expect(source.tags.includes("alpha")).toBe(true);
    expect(source.tags.filter((t) => t.toLowerCase() === "alpha").length).toBe(1);
    expect(source.tags.includes("extra")).toBe(false);
  });

  test("updateKnowledgeSource replaces tags (no concat — dedup replace semantics)", async () => {
    const source = await createKnowledgeSource(
      {
        tenant_id: ctx.tenantId,
        input: { name: "Tag Replace Source", tags: ["original", "tags"], scope: "global" },
        upload: { buffer: Buffer.from("source with tags to replace"), filename: "replace.txt" },
        actor: null,
      },
      ctx.testDb.db,
    );

    expect(source.tags).toEqual(["original", "tags"]);

    const updated = (await updateKnowledgeSource(
      {
        tenant_id: ctx.tenantId,
        id: source.id,
        patch: { tags: ["new", "new", "set"] },
        actor_id: null,
      },
      ctx.testDb.db,
    )) as KnowledgeSourceView;

    expect(updated.tags).toEqual(["new", "set"]);
    expect(updated.tags.includes("original")).toBe(false);
  });

  test("updateKnowledgeSource with duplicate tags dedupes case-insensitively", async () => {
    const source = await createKnowledgeSource(
      {
        tenant_id: ctx.tenantId,
        input: { name: "Case Dedupe Source", scope: "global" },
        upload: { buffer: Buffer.from("case dedupe test"), filename: "case.txt" },
        actor: null,
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

    expect(updated.tags.filter((t) => t.toLowerCase() === "billing").length).toBe(1);
    expect(updated.tags).toEqual(["Billing", "api"]);
  });

  test("createKnowledgeSource with no tags produces empty tags array", async () => {
    const source = await createKnowledgeSource(
      {
        tenant_id: ctx.tenantId,
        input: { name: "No Tags Source", scope: "global" },
        upload: { buffer: Buffer.from("no tags"), filename: "notags.txt" },
        actor: null,
      },
      ctx.testDb.db,
    );

    expect(source.tags).toEqual([]);
  });
});
