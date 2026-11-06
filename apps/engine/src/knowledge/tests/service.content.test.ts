import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog } from "../../db/schema/index.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { getMockProvider, resetMockProvider } from "../../llm/mock-provider.ts";
import { runWithTestEnv } from "../../test-helpers/determinism/env.ts";
import { upsertKnowledgeBundle } from "../bundle-service.ts";
import { getKnowledgeSource } from "../catalog.ts";
import {
  getKnowledgeSourceContent,
  KnowledgeVersionConflictError,
  updateKnowledgeSourceContent,
} from "../content.ts";
import { createKnowledgeSource, updateKnowledgeSource } from "../service.ts";
import type { KnowledgeSourceView } from "../types.ts";
import { ctx, nextUuid, skip, useKnowledgeServiceDb } from "./service-fixtures.ts";

useKnowledgeServiceDb();

describe.skipIf(skip)("knowledge/service", () => {
  test("EngineClient knowledge mutations retain typed actor provenance", async () => {
    const actorId = "20000000-0000-4000-8000-000000000004";
    const client = new EngineClient({
      tenant_id: ctx.tenantId,
      actor_id: actorId,
      actor_type: "system_account",
      db: ctx.testDb.db,
    });
    const source = await client.knowledgeSources.create({
      input: { name: "Engine Client Actor Source", scope: "global" },
      upload: {
        buffer: Buffer.from("# Actor provenance\n\nThis content supports source analysis."),
        filename: "actor-provenance.md",
        mime: "text/markdown",
      },
    });

    await client.knowledgeSources.update(source.id, { name: "Updated Actor Source" });
    await runWithTestEnv({ LLM_PROVIDER: "mock" }, async () => {
      resetMockProvider();
      getMockProvider().generateOverrides.extract = () => ({ tags: ["actor-provenance"] });
      try {
        await client.knowledgeSources.analyze(source.id);
      } finally {
        resetMockProvider();
      }
    });
    await client.knowledgeSources.delete(source.id);

    for (const action of [
      "knowledge_source.updated",
      "knowledge_source.analyzed",
      "knowledge_source.deleted",
    ]) {
      const [audit] = await ctx.testDb.db
        .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenant_id, ctx.tenantId),
            eq(auditLog.resource_id, source.id),
            eq(auditLog.action, action),
          ),
        );
      expect(audit).toEqual({ actor_type: "system_account", actor_id: actorId });
    }
  });

  test("legacy untyped source actor ID is not attributed to a user", async () => {
    const source = await createKnowledgeSource(
      {
        tenant_id: ctx.tenantId,
        input: { name: "Legacy Actor Source" },
        upload: { buffer: Buffer.from("source"), filename: "legacy.md" },
        actor: null,
      },
      ctx.testDb.db,
    );
    const legacyId = nextUuid();
    await updateKnowledgeSource(
      {
        tenant_id: ctx.tenantId,
        id: source.id,
        patch: { name: "Legacy Actor Source Updated" },
        actor_id: legacyId,
      },
      ctx.testDb.db,
    );
    const [audit] = await ctx.testDb.db
      .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(
        and(eq(auditLog.resource_id, source.id), eq(auditLog.action, "knowledge_source.updated")),
      )
      .limit(1);
    expect(audit).toEqual({ actor_type: "unknown", actor_id: null });
    await updateKnowledgeSource(
      {
        tenant_id: ctx.tenantId,
        id: source.id,
        patch: { description: "No actor identity supplied" },
        actor_id: null,
      },
      ctx.testDb.db,
    );
    const [systemAudit] = await ctx.testDb.db
      .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.resource_id, source.id),
          eq(auditLog.action, "knowledge_source.updated"),
          eq(auditLog.actor_type, "system"),
        ),
      )
      .limit(1);
    expect(systemAudit).toEqual({ actor_type: "system", actor_id: null });
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
