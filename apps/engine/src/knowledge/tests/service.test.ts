import { describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import {
  auditLog,
  events,
  knowledgeChunks,
  knowledgeSources,
  knowledgeSourceVersions,
} from "../../db/schema/index.ts";
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
import { ctx, nextUuid, skip, useKnowledgeServiceDb } from "./service-fixtures.ts";

useKnowledgeServiceDb();

describe.skipIf(skip)("knowledge/service", () => {
  let createdId: string;

  test("createKnowledgeSource persists source + chunks + audit", async () => {
    const uploaderId = nextUuid();
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
        actor: { kind: "system_account", id: uploaderId },
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
    expect(audits).toContainEqual(
      expect.objectContaining({
        action: "knowledge_source.created",
        actor_type: "system_account",
        actor_id: uploaderId,
      }),
    );
    const fileAudits = await ctx.testDb.db
      .select({
        actor_type: auditLog.actor_type,
        actor_id: auditLog.actor_id,
        action: auditLog.action,
      })
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.actor_id, uploaderId)));
    const fileEvents = fileAudits.filter((audit) => audit.action.startsWith("file."));
    expect(fileEvents.length).toBeGreaterThanOrEqual(2);
    expect(
      fileEvents.every(
        (audit) => audit.actor_type === "system_account" && audit.actor_id === uploaderId,
      ),
    ).toBe(true);
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
    const editorId = nextUuid();
    const updated = await updateKnowledgeSource(
      {
        tenant_id: ctx.tenantId,
        id: createdId,
        patch: { name: "Updated Compliance", description: "Updated description" },
        actor_id: editorId,
        actor: { kind: "system_account", id: editorId },
      },
      ctx.testDb.db,
    );
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe("Updated Compliance");
    expect(updated!.description).toBe("Updated description");
    const [audit] = await ctx.testDb.db
      .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(
        and(eq(auditLog.resource_id, createdId), eq(auditLog.action, "knowledge_source.updated")),
      )
      .limit(1);
    expect(audit).toEqual({ actor_type: "system_account", actor_id: editorId });
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
});
