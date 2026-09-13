import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { tenants } from "../../db/schema/index.ts";
import {
  createKnowledgeSource,
  invalidateKnowledgeCache,
  searchKnowledge,
  updateKnowledgeSource,
} from "../service.ts";
import { createKnowledgeTestCtx, type KnowledgeTestCtx } from "./setup.ts";

// Requires a real Postgres database — set REQUIRES_PG=0 to skip in environments without a DB.
const skip = process.env.REQUIRES_PG === "0";

let ctx: KnowledgeTestCtx;
let globalSourceId: string;
let workflowSourceId: string;

beforeAll(async () => {
  if (skip) return;
  ctx = await createKnowledgeTestCtx("search");

  // Seed a global knowledge source
  const global = await createKnowledgeSource(
    {
      tenant_id: ctx.tenantId,
      input: { name: "API Guidelines", scope: "global" },
      upload: {
        buffer: Buffer.from(
          "# API Guidelines\n\nAll REST endpoints must return JSON.\nPagination uses cursor-based tokens.\nRate limiting applies at 100 requests per minute.\n\n## Authentication\n\nUse Bearer tokens for all authenticated endpoints.",
        ),
        filename: "api-guidelines.md",
        mime: "text/markdown",
      },
      actor_id: null,
    },
    ctx.testDb.db,
  );
  globalSourceId = global.id;

  // Seed a workflow-scoped knowledge source
  const wf = await createKnowledgeSource(
    {
      tenant_id: ctx.tenantId,
      input: {
        name: "Payment Runbook",
        scope: "workflow",
        workflow_id: ctx.workflowId,
      },
      upload: {
        buffer: Buffer.from(
          "# Payment Processing Runbook\n\nStep 1: Validate payment amount is positive.\nStep 2: Check idempotency key.\nStep 3: Submit to payment gateway.\n\n## Error Handling\n\nRetry on 5xx errors with exponential backoff.",
        ),
        filename: "payment-runbook.md",
        mime: "text/markdown",
      },
      actor_id: null,
    },
    ctx.testDb.db,
  );
  workflowSourceId = wf.id;
}, 60_000);

afterAll(async () => {
  if (!skip && ctx?.cleanup) await ctx.cleanup();
}, 30_000);

describe.skipIf(skip)("knowledge/search", () => {
  test("search finds matching chunks", async () => {
    const hits = await searchKnowledge(
      { tenant_id: ctx.tenantId, query: "pagination cursor" },
      ctx.testDb.db,
    );
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.snippet).toBeDefined();
    expect(hits[0]!.rank).toBeGreaterThan(0);
  });

  test("search returns empty for no matches", async () => {
    const hits = await searchKnowledge(
      { tenant_id: ctx.tenantId, query: "xyznonexistentterm" },
      ctx.testDb.db,
    );
    expect(hits.length).toBe(0);
  });

  test("search with empty query returns empty", async () => {
    const hits = await searchKnowledge({ tenant_id: ctx.tenantId, query: "" }, ctx.testDb.db);
    expect(hits.length).toBe(0);
  });

  test("search with whitespace-only query returns empty", async () => {
    const hits = await searchKnowledge({ tenant_id: ctx.tenantId, query: "   " }, ctx.testDb.db);
    expect(hits.length).toBe(0);
  });

  test("search respects workflow_id filter (includes global + workflow)", async () => {
    const hits = await searchKnowledge(
      {
        tenant_id: ctx.tenantId,
        query: "payment",
        workflow_id: ctx.workflowId,
      },
      ctx.testDb.db,
    );
    // Should find hits from workflow-scoped source
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.knowledge_source_id === workflowSourceId)).toBe(true);
  });

  test("search without workflow_id still finds global sources", async () => {
    const hits = await searchKnowledge(
      { tenant_id: ctx.tenantId, query: "authentication bearer" },
      ctx.testDb.db,
    );
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.knowledge_source_id === globalSourceId)).toBe(true);
  });

  test("search respects limit", async () => {
    const hits = await searchKnowledge(
      { tenant_id: ctx.tenantId, query: "payment", limit: 1 },
      ctx.testDb.db,
    );
    expect(hits.length).toBeLessThanOrEqual(1);
  });

  test("search by specific knowledge_source_ids", async () => {
    const hits = await searchKnowledge(
      {
        tenant_id: ctx.tenantId,
        query: "payment",
        knowledge_source_ids: [workflowSourceId],
      },
      ctx.testDb.db,
    );
    expect(hits.every((h) => h.knowledge_source_id === workflowSourceId)).toBe(true);
  });

  test("search results are ordered by rank descending", async () => {
    const hits = await searchKnowledge(
      { tenant_id: ctx.tenantId, query: "endpoint" },
      ctx.testDb.db,
    );
    if (hits.length > 1) {
      for (let i = 1; i < hits.length; i++) {
        expect(hits[i]!.rank).toBeLessThanOrEqual(hits[i - 1]!.rank);
      }
    }
  });

  // --- source_name and source_tags provenance --------------------------------

  test("search hits carry source_name matching the owning knowledge source", async () => {
    const hits = await searchKnowledge(
      { tenant_id: ctx.tenantId, query: "pagination cursor" },
      ctx.testDb.db,
    );
    expect(hits.length).toBeGreaterThan(0);
    // Every hit must expose the owning source's name — not an empty string
    for (const hit of hits) {
      expect(typeof hit.source_name).toBe("string");
      expect(hit.source_name.length).toBeGreaterThan(0);
    }
    // Hits from the global source must carry its name
    const globalHits = hits.filter((h) => h.knowledge_source_id === globalSourceId);
    expect(globalHits.length).toBeGreaterThan(0);
    expect(globalHits[0]!.source_name).toBe("API Guidelines");
  });

  test("search hits carry source_tags from the owning knowledge source", async () => {
    // Tag the global source
    await updateKnowledgeSource(
      {
        tenant_id: ctx.tenantId,
        id: globalSourceId,
        patch: { tags: ["api", "guidelines"] },
        actor_id: null,
      },
      ctx.testDb.db,
    );
    invalidateKnowledgeCache(ctx.tenantId);

    const hits = await searchKnowledge(
      { tenant_id: ctx.tenantId, query: "pagination cursor" },
      ctx.testDb.db,
    );

    const globalHits = hits.filter((h) => h.knowledge_source_id === globalSourceId);
    expect(globalHits.length).toBeGreaterThan(0);
    expect(globalHits[0]!.source_tags).toContain("api");
    expect(globalHits[0]!.source_tags).toContain("guidelines");
  });

  // --- tags filter -----------------------------------------------------------

  test("tags filter narrows results to sources carrying any of the specified tags", async () => {
    // Tag the workflow source with "runbook" and ensure the global source has a different tag
    await updateKnowledgeSource(
      {
        tenant_id: ctx.tenantId,
        id: workflowSourceId,
        patch: { tags: ["runbook", "payments"] },
        actor_id: null,
      },
      ctx.testDb.db,
    );
    await updateKnowledgeSource(
      {
        tenant_id: ctx.tenantId,
        id: globalSourceId,
        patch: { tags: ["api", "guidelines"] },
        actor_id: null,
      },
      ctx.testDb.db,
    );
    invalidateKnowledgeCache(ctx.tenantId);

    // Searching with tag "runbook" should only find chunks from the workflow source
    const runbookHits = await searchKnowledge(
      { tenant_id: ctx.tenantId, query: "payment", tags: ["runbook"] },
      ctx.testDb.db,
    );
    expect(runbookHits.length).toBeGreaterThan(0);
    expect(runbookHits.every((h) => h.knowledge_source_id === workflowSourceId)).toBe(true);

    // Searching with tag "api" should only find chunks from the global source
    const apiHits = await searchKnowledge(
      { tenant_id: ctx.tenantId, query: "authentication bearer", tags: ["api"] },
      ctx.testDb.db,
    );
    expect(apiHits.length).toBeGreaterThan(0);
    expect(apiHits.every((h) => h.knowledge_source_id === globalSourceId)).toBe(true);
  });

  test("tags filter is tenant-isolated: a tag from another tenant does not narrow cross-tenant", async () => {
    // Seed a second tenant with its own source tagged "payments"
    const [otherTenant] = await ctx.testDb.db
      .insert(tenants)
      .values({ slug: "other-tenant-tags", display_name: "Other Tenant Tags" })
      .returning();
    expect(otherTenant).toBeDefined();

    await createKnowledgeSource(
      {
        tenant_id: otherTenant!.id,
        input: { name: "Other Payments Doc", tags: ["payments"] },
        upload: {
          buffer: Buffer.from("Payment processing with idempotency keys and retry logic."),
          filename: "payments.txt",
        },
        actor_id: null,
      },
      ctx.testDb.db,
    );

    // Other tenant's "payments" tag must not bleed into ctx.tenantId search
    const hits = await searchKnowledge(
      { tenant_id: ctx.tenantId, query: "payment", tags: ["payments"] },
      ctx.testDb.db,
    );
    // All hits (if any) must belong to ctx.tenantId sources, not otherTenant
    for (const hit of hits) {
      expect(hit.knowledge_source_id).not.toBe(otherTenant!.id);
    }
  });

  test("cache key distinguishes different tag filters (no cross-contamination)", async () => {
    invalidateKnowledgeCache(ctx.tenantId);

    // Warm the cache with a "runbook" tag filter
    const runbookHits = await searchKnowledge(
      { tenant_id: ctx.tenantId, query: "payment", tags: ["runbook"] },
      ctx.testDb.db,
    );

    // A different tag filter must not return the cached "runbook" result
    const apiHits = await searchKnowledge(
      { tenant_id: ctx.tenantId, query: "authentication bearer", tags: ["api"] },
      ctx.testDb.db,
    );

    // The two result sets must differ (or at minimum not be identical when
    // sources are tagged differently)
    const runbookIds = new Set(runbookHits.map((h) => h.knowledge_source_id));
    const apiIds = new Set(apiHits.map((h) => h.knowledge_source_id));

    // The api-filtered hits must NOT include the workflow source (runbook-tagged)
    expect(apiIds.has(workflowSourceId)).toBe(false);
    // The runbook-filtered hits must NOT include the global source (api-tagged)
    expect(runbookIds.has(globalSourceId)).toBe(false);
  });

  test("search respects tenant isolation", async () => {
    // Create a second tenant and verify it can't see tenant 1's knowledge
    const [otherTenant] = await ctx.testDb.db
      .insert(tenants)
      .values({ slug: "other-tenant-search", display_name: "Other Tenant" })
      .returning();
    expect(otherTenant).toBeDefined();

    // Seed knowledge in the other tenant
    await createKnowledgeSource(
      {
        tenant_id: otherTenant!.id,
        input: { name: "Other Docs" },
        upload: {
          buffer: Buffer.from("Completely different content about zeppelins and airships."),
          filename: "other.txt",
        },
        actor_id: null,
      },
      ctx.testDb.db,
    );

    // Tenant 1 searching for other tenant's content should find nothing
    const crossTenantHits = await searchKnowledge(
      { tenant_id: ctx.tenantId, query: "zeppelins airships" },
      ctx.testDb.db,
    );
    expect(crossTenantHits.length).toBe(0);

    // Other tenant searching for tenant 1's content should find nothing
    const reverseCrossHits = await searchKnowledge(
      { tenant_id: otherTenant!.id, query: "pagination cursor bearer" },
      ctx.testDb.db,
    );
    expect(reverseCrossHits.length).toBe(0);

    // Other tenant searching for its own content should work
    const ownHits = await searchKnowledge(
      { tenant_id: otherTenant!.id, query: "zeppelins" },
      ctx.testDb.db,
    );
    expect(ownHits.length).toBeGreaterThan(0);
  });
});
