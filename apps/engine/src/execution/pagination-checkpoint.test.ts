// Pagination progress checkpoint + complete retry integration.
//
// Two scenarios:
//   1. A 200-page run that fails at page 51 must persist
//      `request_meta.pagination_checkpoint` after page 50 (the checkpoint
//      window) so the row reflects the resume position.
//   2. Re-running the same step_row_id restarts at page 1 and returns all
//      10,000 items. Cursor-only resume would silently discard pages 1..50.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { executionSteps, executions, tenants } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { RunLlmBudget } from "../llm/accounting/index.ts";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
import type { RequestStep } from "../workflows/types.ts";
import {
  type PaginationCheckpoint,
  paginationSignature,
  readPaginationCheckpoint,
  writePaginationCheckpoint,
} from "./pagination.ts";
import { runRequestStep } from "./steps/request.ts";
import { createMockServer, jsonResponse, type MockServer } from "./tests/setup.ts";
import type { StepRunContext } from "./types.ts";

const TEST_NOW_MS = getTestNow();

let testDb: TestDb;
let tenantId: string;
let mock: MockServer;

const PAGE_SIZE = 50;
const TOTAL_PAGES = 200;
let serverHits = 0;
let failOnPage: number | null = null;

beforeAll(async () => {
  testDb = await createTestDb("pagination-checkpoint");
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "pg-checkpoint", display_name: "Pagination Checkpoint" })
    .returning();
  if (!tenant) throw new Error("tenant insert failed");
  tenantId = tenant.id;

  mock = await createMockServer((req, res) => {
    serverHits += 1;
    const url = new URL(req.url ?? "/", "http://x");
    const page = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
    if (failOnPage !== null && page === failOnPage) {
      jsonResponse(res, 500, { error: `forced failure on page ${page}` });
      return;
    }
    if (page < 1 || page > TOTAL_PAGES) {
      // Out-of-range: empty array, signals stop.
      jsonResponse(res, 200, { items: [] });
      return;
    }
    // PAGE_SIZE records of monotonically increasing ids per page.
    const items = Array.from({ length: PAGE_SIZE }, (_, i) => ({
      id: (page - 1) * PAGE_SIZE + i,
    }));
    jsonResponse(res, 200, { items });
  });
});

afterAll(async () => {
  await mock.close();
  await testDb.cleanup();
});

async function createExecutionRow(): Promise<{ execution_id: string; step_row_id: string }> {
  const [exec] = await testDb.db
    .insert(executions)
    .values({
      tenant_id: tenantId,
      source_kind: "step",
      status: "running",
      request_source: "api",
      execution_mode: "dev",
    })
    .returning({ id: executions.id });
  if (!exec) throw new Error("exec insert failed");
  const [stepRow] = await testDb.db
    .insert(executionSteps)
    .values({
      tenant_id: tenantId,
      execution_id: exec.id,
      step_key: "fetch-pages",
      step_index: 0,
      kind: "request",
      status: "running",
      started_at: new Date(TEST_NOW_MS),
    })
    .returning({ id: executionSteps.id });
  if (!stepRow) throw new Error("step row insert failed");
  return { execution_id: exec.id, step_row_id: stepRow.id };
}

function makeStepRunCtx(input: {
  execution_id: string;
  step_row_id: string;
  step: RequestStep;
}): StepRunContext {
  // Build only the StepRunContext fields runRequestStep actually reads.
  // The unused workflow fields fall back to safe defaults — tested against
  // the request step here, not the whole engine.
  return {
    db: testDb.db,
    tenant_id: tenantId,
    execution_id: input.execution_id,
    workflow_id: "",
    workflow_version_id: "",
    request_source: "api",
    parent_execution_id: null,
    depth: 0,
    signal: new AbortController().signal,
    scope: {},
    started_at: new Date(TEST_NOW_MS),
    workflow_slug: "test",
    trace_id: null,
    principal: null,
    execution_mode: "dev",
    step: input.step,
    step_index: 0,
    step_row_id: input.step_row_id,
    persist_workflow_refs: true,
    llm_budget: new RunLlmBudget(null),
  };
}

describe("pagination checkpoint", () => {
  test("POST body pagination materializes vendor parameters and concatenates items", async () => {
    const seenBodies: Array<Record<string, unknown>> = [];
    let failFirstRead = true;
    const postMock = await createMockServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      seenBodies.push(body);
      if (failFirstRead) {
        failFirstRead = false;
        jsonResponse(res, 503, { error: "temporary" });
        return;
      }
      const startRow = Number(body.startRow);
      const rows = startRow === 0 ? [{ key: "a" }, { key: "b" }] : [{ key: "c" }];
      jsonResponse(res, 200, { rows });
    });

    try {
      const { execution_id, step_row_id } = await createExecutionRow();
      const step: RequestStep = {
        id: "search-console",
        kind: "request",
        method: "POST",
        side_effects: "read",
        url: `${postMock.baseUrl}/searchAnalytics/query`,
        body: { startDate: "2026-07-01", dimensions: ["query", "page"] },
        body_schema: {
          type: "object",
          required: ["startDate", "dimensions", "startRow", "rowLimit"],
        },
        pagination: {
          strategy: "offset",
          parameter_location: "body",
          page_size: 2,
          offset_param: "startRow",
          limit_param: "rowLimit",
          items_path: "rows",
          max_pages: 10,
        },
        max_retries: 1,
        retry_backoff_ms: 50,
      };
      const ctx = makeStepRunCtx({ execution_id, step_row_id, step });
      const result = await runRequestStep({ ctx, step, scope: {} });

      expect(result.status).toBe("succeeded");
      expect(result.output).toEqual([{ key: "a" }, { key: "b" }, { key: "c" }]);
      expect(seenBodies).toEqual([
        {
          startDate: "2026-07-01",
          dimensions: ["query", "page"],
          startRow: 0,
          rowLimit: 2,
        },
        {
          startDate: "2026-07-01",
          dimensions: ["query", "page"],
          startRow: 0,
          rowLimit: 2,
        },
        {
          startDate: "2026-07-01",
          dimensions: ["query", "page"],
          startRow: 2,
          rowLimit: 2,
        },
      ]);
    } finally {
      await postMock.close();
    }
  });

  test("POST body pagination can preserve each raw response page", async () => {
    const postMock = await createMockServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      const offset = Number(body.offset);
      const rows = offset === 0 ? [{ key: "a" }, { key: "b" }] : [{ key: "c" }];
      jsonResponse(res, 200, { rows, rowCount: 3, metadata: { offset } });
    });

    try {
      const { execution_id, step_row_id } = await createExecutionRow();
      const step: RequestStep = {
        id: "analytics-pages",
        kind: "request",
        method: "POST",
        side_effects: "read",
        url: `${postMock.baseUrl}/runReport`,
        body: { dateRanges: [{ startDate: "2026-07-01", endDate: "2026-07-28" }] },
        pagination: {
          strategy: "offset",
          parameter_location: "body",
          output_mode: "pages",
          page_size: 2,
          offset_param: "offset",
          limit_param: "limit",
          items_path: "rows",
          max_pages: 10,
        },
        max_retries: 0,
      };
      const ctx = makeStepRunCtx({ execution_id, step_row_id, step });
      const result = await runRequestStep({ ctx, step, scope: {} });

      expect(result.status).toBe("succeeded");
      expect(result.output).toEqual([
        { rows: [{ key: "a" }, { key: "b" }], rowCount: 3, metadata: { offset: 0 } },
        { rows: [{ key: "c" }], rowCount: 3, metadata: { offset: 2 } },
      ]);
      expect((result.request_meta as { pages_fetched?: number } | undefined)?.pages_fetched).toBe(
        2,
      );
    } finally {
      await postMock.close();
    }
  });

  test("max_pages fails closed instead of returning a silent prefix", async () => {
    const limitMock = await createMockServer((_req, res) => {
      jsonResponse(res, 200, { rows: [{ id: 1 }, { id: 2 }] });
    });
    try {
      const { execution_id, step_row_id } = await createExecutionRow();
      const step: RequestStep = {
        id: "bounded-report",
        kind: "request",
        method: "GET",
        url: `${limitMock.baseUrl}/report`,
        pagination: {
          strategy: "offset",
          page_size: 2,
          offset_param: "offset",
          limit_param: "limit",
          items_path: "rows",
          max_pages: 1,
        },
        max_retries: 0,
      };
      const ctx = makeStepRunCtx({ execution_id, step_row_id, step });
      const result = await runRequestStep({ ctx, step, scope: {} });

      expect(result.status).toBe("failed");
      expect(result.error?.message).toContain("max_pages=1");
      expect(limitMock.callCount()).toBe(1);
    } finally {
      await limitMock.close();
    }
  });

  test("write + read round-trip preserves shape and signature", async () => {
    const { step_row_id } = await createExecutionRow();
    const cp: PaginationCheckpoint = {
      state: { kind: "page", page: 50 },
      page_idx: 50,
      accumulated_count: 2500,
      signature: "sig-abc",
      written_at: new Date(TEST_NOW_MS).toISOString(),
    };
    await writePaginationCheckpoint(tenantId, step_row_id, cp, testDb.db);
    const round = await readPaginationCheckpoint(tenantId, step_row_id, testDb.db);
    expect(round).not.toBeNull();
    expect(round?.state).toEqual({ kind: "page", page: 50 });
    expect(round?.page_idx).toBe(50);
    expect(round?.accumulated_count).toBe(2500);
    expect(round?.signature).toBe("sig-abc");
  });

  test("write merges into existing request_meta without clobbering siblings", async () => {
    const { step_row_id } = await createExecutionRow();
    await testDb.db
      .update(executionSteps)
      .set({ request_meta: { url: "http://example", status: 200 } })
      .where(eq(executionSteps.id, step_row_id));
    const cp: PaginationCheckpoint = {
      state: { kind: "offset", offset: 100 },
      page_idx: 2,
      accumulated_count: 200,
      signature: "sig-1",
      written_at: new Date(TEST_NOW_MS).toISOString(),
    };
    await writePaginationCheckpoint(tenantId, step_row_id, cp, testDb.db);
    const rows = await testDb.db
      .select()
      .from(executionSteps)
      .where(eq(executionSteps.id, step_row_id));
    const meta = rows[0]?.request_meta as Record<string, unknown>;
    expect(meta.url).toBe("http://example");
    expect(meta.status).toBe(200);
    expect((meta.pagination_checkpoint as Record<string, unknown>).page_idx).toBe(2);
  });

  test("failed run restarts at page 1 and returns a complete result", async () => {
    serverHits = 0;
    failOnPage = 51;
    const { execution_id, step_row_id } = await createExecutionRow();
    const step: RequestStep = {
      id: "fetch-pages",
      kind: "request",
      method: "GET",
      url: `${mock.baseUrl}/items`,
      pagination: {
        strategy: "page",
        page_size: PAGE_SIZE,
        page_param: "page",
        limit_param: "limit",
        start_page: 1,
      },
      max_retries: 0,
    };

    // First run: server returns 500 on page 51 — request step fails.
    const ctx1 = makeStepRunCtx({ execution_id, step_row_id, step });
    const r1 = await runRequestStep({ ctx: ctx1, step, scope: {} });
    expect(r1.status).toBe("failed");

    // After failure the row's request_meta should hold the checkpoint
    // recorded at page 50 (the most recent multiple of the 50-page window).
    const cp = await readPaginationCheckpoint(tenantId, step_row_id, testDb.db);
    expect(cp).not.toBeNull();
    expect(cp?.state).toEqual({ kind: "page", page: 50 });
    expect(cp?.page_idx).toBe(50);
    expect(cp?.accumulated_count).toBe(50 * PAGE_SIZE);
    // Signature should match the same request shape used in run #2.
    const expectedSig = paginationSignature({
      base_url: `${new URL(`${mock.baseUrl}/items`).origin}/items`,
      path_or_url: `${mock.baseUrl}/items`,
      query: {},
      body: null,
      pagination: step.pagination,
    });
    expect(cp?.signature).toBe(expectedSig);

    // Second run: same step_row_id and request shape. The checkpoint is read
    // as progress evidence, but the fetch restarts at page 1 because the
    // earlier page bodies were not durably stored.
    failOnPage = null;
    const hitsBeforeRetry = serverHits;

    const ctx2 = makeStepRunCtx({ execution_id, step_row_id, step });
    const r2 = await runRequestStep({ ctx: ctx2, step, scope: {} });
    expect(r2.status).toBe("succeeded");
    const hitsForRetry = serverHits - hitsBeforeRetry;
    expect(hitsForRetry).toBeGreaterThanOrEqual(200);
    expect(hitsForRetry).toBeLessThanOrEqual(201);
    const items = r2.output as unknown[];
    expect(items.length).toBe(TOTAL_PAGES * PAGE_SIZE);
    const meta = r2.request_meta as {
      resumed_from_page?: number;
      resumed_accumulated_count?: number;
    };
    expect(meta.resumed_from_page).toBeUndefined();
    expect(meta.resumed_accumulated_count).toBeUndefined();
  });

  test("signature mismatch invalidates resume", async () => {
    serverHits = 0;
    failOnPage = null;
    const { execution_id, step_row_id } = await createExecutionRow();

    // Pre-seed a checkpoint with a wrong signature.
    const stale: PaginationCheckpoint = {
      state: { kind: "page", page: 5 },
      page_idx: 5,
      accumulated_count: 5 * PAGE_SIZE,
      signature: "sig-from-an-old-workflow-shape",
      written_at: new Date(TEST_NOW_MS).toISOString(),
    };
    await writePaginationCheckpoint(tenantId, step_row_id, stale, testDb.db);

    const step: RequestStep = {
      id: "fetch-pages",
      kind: "request",
      method: "GET",
      url: `${mock.baseUrl}/items`,
      pagination: {
        strategy: "page",
        page_size: PAGE_SIZE,
        page_param: "page",
        limit_param: "limit",
        start_page: 1,
      },
      max_retries: 0,
    };
    const ctx = makeStepRunCtx({ execution_id, step_row_id, step });
    const r = await runRequestStep({ ctx, step, scope: {} });
    expect(r.status).toBe("succeeded");
    const meta = r.request_meta as { resumed_from_page?: number };
    // No resume keys — the stale signature was rejected and the run
    // started from page 1.
    expect(meta.resumed_from_page).toBeUndefined();
    expect((r.output as unknown[]).length).toBe(TOTAL_PAGES * PAGE_SIZE);
  });

  test("cross-tenant read returns null (defense-in-depth predicate)", async () => {
    // Seed a checkpoint under tenant A, then read it back as tenant B.
    // Without the tenant_id predicate the prior PK-only lookup would
    // surface tenant A's row to tenant B; with the predicate the query
    // returns nothing.
    const { step_row_id } = await createExecutionRow();
    const cp: PaginationCheckpoint = {
      state: { kind: "page", page: 7 },
      page_idx: 7,
      accumulated_count: 7 * PAGE_SIZE,
      signature: "sig-cross-tenant",
      written_at: new Date(TEST_NOW_MS).toISOString(),
    };
    await writePaginationCheckpoint(tenantId, step_row_id, cp, testDb.db);

    // Stand up a second tenant in the same DB and try to read tenant
    // A's checkpoint with tenant B's id.
    const [otherTenant] = await testDb.db
      .insert(tenants)
      .values({ slug: "pg-checkpoint-other", display_name: "Other Tenant" })
      .returning();
    if (!otherTenant) throw new Error("second tenant insert failed");

    const cross = await readPaginationCheckpoint(otherTenant.id, step_row_id, testDb.db);
    expect(cross).toBeNull();

    // Sanity: same row read with the right tenant still returns the
    // checkpoint (proves the test query path is exercised).
    const same = await readPaginationCheckpoint(tenantId, step_row_id, testDb.db);
    expect(same).not.toBeNull();
    expect(same?.signature).toBe("sig-cross-tenant");
  });

  test("cross-tenant write does not clobber another tenant's request_meta", async () => {
    // Same shape as above but for the write path. Issuing a write
    // with tenant B's id against tenant A's step row updates zero
    // rows; tenant A's checkpoint stays intact.
    const { step_row_id } = await createExecutionRow();
    const original: PaginationCheckpoint = {
      state: { kind: "offset", offset: 100 },
      page_idx: 2,
      accumulated_count: 100,
      signature: "sig-original",
      written_at: new Date(TEST_NOW_MS).toISOString(),
    };
    await writePaginationCheckpoint(tenantId, step_row_id, original, testDb.db);

    const [otherTenant] = await testDb.db
      .insert(tenants)
      .values({ slug: "pg-checkpoint-other-w", display_name: "Other Tenant W" })
      .returning();
    if (!otherTenant) throw new Error("second tenant insert failed");

    const hostile: PaginationCheckpoint = {
      state: { kind: "offset", offset: 9999 },
      page_idx: 999,
      accumulated_count: 99999,
      signature: "sig-hostile",
      written_at: new Date(TEST_NOW_MS).toISOString(),
    };
    await writePaginationCheckpoint(otherTenant.id, step_row_id, hostile, testDb.db);

    const round = await readPaginationCheckpoint(tenantId, step_row_id, testDb.db);
    expect(round?.signature).toBe("sig-original");
    expect(round?.page_idx).toBe(2);
  });
});
