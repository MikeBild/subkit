// Pagination resume — checkpoint write/read + integration with runRequestStep.
//
// Two scenarios:
//   1. A 200-page run that fails at page 51 must persist
//      `request_meta.pagination_checkpoint` after page 50 (the checkpoint
//      window) so the row reflects the resume position.
//   2. Re-running the same step_row_id reads that checkpoint and resumes
//      from page 51. The total accumulated count = 200 * 50 = 10_000 across
//      both runs.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { executionSteps, executions, tenants } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
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

const TEST_NOW_MS = 1_700_000_000_000;

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
  };
}

describe("pagination checkpoint", () => {
  test("write + read round-trip preserves shape and signature", async () => {
    const { step_row_id } = await createExecutionRow();
    const cp: PaginationCheckpoint = {
      state: { kind: "page", page: 50 },
      page_idx: 50,
      accumulated_count: 2500,
      signature: "sig-abc",
      written_at: new Date(TEST_NOW_MS).toISOString(),
    };
    await writePaginationCheckpoint(step_row_id, cp, testDb.db);
    const round = await readPaginationCheckpoint(step_row_id, testDb.db);
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
    await writePaginationCheckpoint(step_row_id, cp, testDb.db);
    const rows = await testDb.db
      .select()
      .from(executionSteps)
      .where(eq(executionSteps.id, step_row_id));
    const meta = rows[0]?.request_meta as Record<string, unknown>;
    expect(meta.url).toBe("http://example");
    expect(meta.status).toBe(200);
    expect((meta.pagination_checkpoint as Record<string, unknown>).page_idx).toBe(2);
  });

  test("failed-then-resume flow: 200-page run aborts at page 51, restart picks up from page 51", async () => {
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
    const cp = await readPaginationCheckpoint(step_row_id, testDb.db);
    expect(cp).not.toBeNull();
    expect(cp?.state).toEqual({ kind: "page", page: 50 });
    expect(cp?.page_idx).toBe(50);
    expect(cp?.accumulated_count).toBe(50 * PAGE_SIZE);
    // Signature should match the same request shape used in run #2.
    const expectedSig = paginationSignature({
      base_url: `${new URL(`${mock.baseUrl}/items`).origin}/items`,
      path_or_url: `${mock.baseUrl}/items`,
      query: {},
    });
    expect(cp?.signature).toBe(expectedSig);

    // Second run: same step_row_id, same step. Lift the failure and let it
    // run to completion. The strategy must seed from the checkpoint and
    // resume at page 51 — verified by both the final accumulated count
    // and the fact that pages 1..50 do NOT hit the mock again.
    failOnPage = null;
    const hitsBeforeResume = serverHits;

    const ctx2 = makeStepRunCtx({ execution_id, step_row_id, step });
    const r2 = await runRequestStep({ ctx: ctx2, step, scope: {} });
    expect(r2.status).toBe("succeeded");
    // Output is just the second-run accumulator (pages 51..200) — the
    // first 50 pages live in the prior run's already-discarded result.
    // What matters for the test is that no duplicate fetches happened.
    const hitsForResume = serverHits - hitsBeforeResume;
    // Expect 150 page fetches (51..200) + 1 trailing empty / short-page
    // detection — the page strategy stops when `arr.length < page_size`,
    // and page 200 returns exactly page_size items so there's a 201 fetch
    // that returns empty items.
    expect(hitsForResume).toBeGreaterThanOrEqual(150);
    expect(hitsForResume).toBeLessThanOrEqual(151);
    // Output items reflect resume-only accumulation: 150 pages × PAGE_SIZE.
    const items = r2.output as unknown[];
    expect(items.length).toBe(150 * PAGE_SIZE);
    // Resume metadata is now first-class on the http variant.
    const meta = r2.request_meta as {
      resumed_from_page?: number;
      resumed_accumulated_count?: number;
    };
    expect(meta.resumed_from_page).toBe(50);
    expect(meta.resumed_accumulated_count).toBe(50 * PAGE_SIZE);
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
    await writePaginationCheckpoint(step_row_id, stale, testDb.db);

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
});
