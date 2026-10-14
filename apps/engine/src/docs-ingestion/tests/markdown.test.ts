import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { auditLog } from "../../db/schema/index.ts";
import { ingestDocs } from "../service.ts";
import { chunkMarkdown } from "../sources/markdown.ts";
import { createDocsTestCtx, type DocsTestCtx } from "./setup.ts";

let ctx: DocsTestCtx;

beforeAll(async () => {
  ctx = await createDocsTestCtx("markdown");
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("docs-ingestion/markdown", () => {
  test("chunkMarkdown splits on headings and returns one chunk per section", () => {
    const md = `# Top\n\nIntro paragraph.\n\n## Section A\n\nAlpha content.\n\n## Section B\n\nBravo content.`;
    const chunks = chunkMarkdown(md);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const titles = chunks.map((c) => c.title);
    expect(titles).toContain("Section A");
    expect(titles).toContain("Section B");
    const a = chunks.find((c) => c.title === "Section A");
    expect(a?.content).toContain("Alpha content");
  });

  test("chunkMarkdown with no headings emits a single chunk", () => {
    const chunks = chunkMarkdown("just one line");
    expect(chunks.length).toBe(1);
    expect(chunks[0]?.title).toBeNull();
  });

  test("ingestDocs accepts raw markdown content", async () => {
    const md = `# Top\n\n## Alpha\n\nFirst alpha.\n\n## Beta\n\nSecond beta.\n`;
    const result = await ingestDocs(
      {
        tenant_id: ctx.tenantId,
        connector_id: ctx.connectorId,
        input: { source_type: "markdown", content: md },
      },
      ctx.testDb.db,
    );
    expect(result.ingested_count).toBeGreaterThanOrEqual(2);
    expect(result.budget_exceeded).toBe(false);
    expect(result.total_bytes).toBeGreaterThan(0);
  });

  test("ingest audit preserves a typed system-account actor", async () => {
    const actorId = "00000000-0000-4000-8000-000000000033";
    const result = await ingestDocs(
      {
        tenant_id: ctx.tenantId,
        connector_id: ctx.connectorId,
        input: { source_type: "markdown", content: "# Actor provenance\n\nTyped actor." },
        actor_id: actorId,
        actor: { kind: "system_account", id: actorId },
      },
      ctx.testDb.db,
    );
    const [audit] = await ctx.testDb.db
      .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.resource_id, ctx.connectorId),
          eq(auditLog.action, "connector.docs_ingested"),
          sql`${auditLog.metadata}->>'document_id' = ${result.document_id}`,
        ),
      )
      .limit(1);
    expect(result.document_id).not.toBeNull();
    expect(audit).toEqual({ actor_type: "system_account", actor_id: actorId });
  });

  test("ingest audit keeps missing actors system and legacy IDs unknown", async () => {
    const legacyId = "00000000-0000-4000-8000-000000000036";
    const common = (url: string) => ({
      tenant_id: ctx.tenantId,
      connector_id: ctx.connectorId,
      input: {
        source_type: "markdown" as const,
        content: "# Provenance\n\nBody.",
        url,
      },
    });
    const missingResult = await ingestDocs(common("inline:actor-missing"), ctx.testDb.db);
    const legacyResult = await ingestDocs(
      { ...common("inline:actor-legacy"), actor_id: legacyId },
      ctx.testDb.db,
    );
    const readAudit = async (documentId: string | null) => {
      const [audit] = await ctx.testDb.db
        .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.resource_id, ctx.connectorId),
            eq(auditLog.action, "connector.docs_ingested"),
            sql`${auditLog.metadata}->>'document_id' = ${documentId}`,
          ),
        )
        .limit(1);
      return audit;
    };
    expect(missingResult.document_id).not.toBeNull();
    expect(legacyResult.document_id).not.toBeNull();
    expect(await readAudit(missingResult.document_id)).toEqual({
      actor_type: "system",
      actor_id: null,
    });
    expect(await readAudit(legacyResult.document_id)).toEqual({
      actor_type: "unknown",
      actor_id: null,
    });
  });
});
