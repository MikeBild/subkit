import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { connectorDocumentChunks, connectorDocuments, connectors } from "../../db/schema/index.ts";
import { createBoss, disposeBoss } from "../../queue/boss.ts";
import { INGEST_DOCS_QUEUE } from "../../queue/handlers/ingest-docs.ts";
import { isCronDue, SchedulerReconciler } from "../../scheduler/reconciler.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { ingestDocs } from "../service.ts";
import { createDocsTestCtx, type DocsTestCtx, stubFetch } from "./setup.ts";

const TEST_NOW_MS = getTestNow();

const ORIGINAL_SPEC = {
  openapi: "3.0.0",
  info: { title: "Refresh", version: "1.0.0" },
  paths: {
    "/a": {
      get: { summary: "a one", responses: { "200": { description: "ok" } } },
    },
  },
};

const CHANGED_SPEC = {
  openapi: "3.0.0",
  info: { title: "Refresh", version: "1.0.1" },
  paths: {
    "/a": {
      get: { summary: "a one v2", responses: { "200": { description: "ok" } } },
    },
    "/b": {
      get: { summary: "b brand new", responses: { "200": { description: "ok" } } },
    },
  },
};

let ctx: DocsTestCtx;

beforeAll(async () => {
  ctx = await createDocsTestCtx("refresh");
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("docs-ingestion/refresh", () => {
  test("a second ingest on the same source writes fresh chunks", async () => {
    const url = "https://ex.test/refresh.json";
    const firstFetch = stubFetch({ [url]: { body: JSON.stringify(ORIGINAL_SPEC) } });
    const first = await ingestDocs(
      {
        tenant_id: ctx.tenantId,
        connector_id: ctx.connectorId,
        input: { source_type: "openapi", url },
        fetchImpl: firstFetch,
      },
      ctx.testDb.db,
    );
    expect(first.ingested_count).toBe(2);

    const secondFetch = stubFetch({ [url]: { body: JSON.stringify(CHANGED_SPEC) } });
    const second = await ingestDocs(
      {
        tenant_id: ctx.tenantId,
        connector_id: ctx.connectorId,
        input: { source_type: "openapi", url },
        fetchImpl: secondFetch,
      },
      ctx.testDb.db,
    );
    expect(second.ingested_count).toBe(3);

    const docs = await ctx.testDb.db
      .select()
      .from(connectorDocuments)
      .where(
        and(
          eq(connectorDocuments.tenant_id, ctx.tenantId),
          eq(connectorDocuments.connector_id, ctx.connectorId),
        ),
      );
    expect(docs.length).toBeGreaterThanOrEqual(2);

    const secondDoc = docs.find((d) => d.id === second.document_id);
    expect(secondDoc).toBeTruthy();
    const chunks = await ctx.testDb.db
      .select()
      .from(connectorDocumentChunks)
      .where(eq(connectorDocumentChunks.document_id, secondDoc!.id));
    expect(chunks.length).toBe(3);
  });

  test("isCronDue treats a never-fired connector as due", () => {
    expect(isCronDue("every:60", null, new Date(TEST_NOW_MS))).toBe(true);
    const justFired = new Date(TEST_NOW_MS);
    expect(isCronDue("every:1", justFired, new Date(justFired.getTime() + 500))).toBe(false);
    expect(isCronDue("every:1", justFired, new Date(justFired.getTime() + 2000))).toBe(true);
  });

  test("auto-refresh reconciler enqueues an ingest job when the cron elapses", async () => {
    const boss = await createBoss({ connectionString: ctx.testDb.url });
    try {
      await ctx.testDb.db
        .update(connectors)
        .set({
          auto_refresh_cron: "every:1",
          last_ingested_at: null,
          config: {
            docs_source_type: "openapi",
            docs_source_url: "https://ex.test/refresh.json",
          },
        })
        .where(eq(connectors.id, ctx.connectorId));

      const reconciler = new SchedulerReconciler({
        boss,
        db: ctx.testDb.db,
        intervalMs: 60_000,
      });
      await reconciler.reconcileDocsAutoRefresh();

      const rows = await ctx.testDb.db
        .select()
        .from(connectors)
        .where(eq(connectors.id, ctx.connectorId));
      expect(rows[0]?.last_ingested_at).not.toBeNull();

      const jobs = await boss.fetch<{ connector_id?: string }>(INGEST_DOCS_QUEUE, {
        batchSize: 5,
      });
      expect(Array.isArray(jobs)).toBe(true);
      expect((jobs ?? []).length).toBeGreaterThanOrEqual(1);
      const ids = (jobs ?? []).map((j) => j.data?.connector_id);
      expect(ids).toContain(ctx.connectorId);
    } finally {
      await disposeBoss(boss);
    }
  }, 30_000);
});
