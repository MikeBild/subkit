import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { ServerResponse } from "node:http";
import { and, asc, eq } from "drizzle-orm";
import { auditLog, connectors, executionSteps, executions } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { RunLlmBudget } from "../../../llm/accounting/index.ts";
import { getTestNow } from "../../../test-helpers/determinism/clock.ts";
import { createMockServer, type MockServer } from "../../../test-helpers/mock-http.ts";
import { seedTenant } from "../../../test-helpers/seed.ts";
import { type RequestStep, RequestStepSchema } from "../../../workflows/types.ts";
import { envelopeFor } from "../../engine/envelope.ts";
import type { StepRunContext } from "../../types.ts";
import { runRequestStep } from "../request.ts";
import { withRateLimitClockForTests } from "./rate-limit.ts";

const TEST_NOW_MS = getTestNow();

let testDb: TestDb;
let tenantId: string;
let connectorId: string;
let mock: MockServer;
let hits: string[] = [];
let mode: "link" | "duplicate" | "clamp" | "primary_limit" | "secondary_limit" | "long_limit" =
  "link";
let limitedOnce = false;

const TOTAL = 237;
const item = (id: number) => ({ id, number: id, title: `issue ${id}` });

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string>) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  res.end(JSON.stringify(body));
}

beforeAll(async () => {
  testDb = await createTestDb("rest-pagination-dispatch");
  const tenant = await seedTenant(testDb.db, { slug: "rest-paging", display_name: "REST paging" });
  tenantId = tenant.id;
  mock = await createMockServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://mock");
    hits.push(`${url.pathname}${url.search}`);
    if (mode === "primary_limit" && !limitedOnce) {
      limitedOnce = true;
      return send(
        res,
        403,
        { message: "API rate limit exceeded for user ID 1." },
        {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(Math.floor(TEST_NOW_MS / 1000) + 2),
        },
      );
    }
    if (mode === "secondary_limit" && !limitedOnce) {
      limitedOnce = true;
      return send(
        res,
        403,
        { message: "You have exceeded a secondary rate limit. Please wait a few minutes." },
        {},
      );
    }
    if (mode === "long_limit") {
      return send(
        res,
        403,
        { message: "API rate limit exceeded for user ID 1." },
        {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(Math.floor(TEST_NOW_MS / 1000) + 3000),
        },
      );
    }
    if (url.pathname === "/repos/o/r/commits") {
      const perPage = Math.min(Number(url.searchParams.get("per_page") ?? "30"), 50);
      const pageNo = Number(url.searchParams.get("page") ?? "1");
      const rows = Array.from({ length: perPage }, (_, i) => ({ sha: `s${pageNo}-${i}` }));
      return send(res, 200, rows, {
        link: `<${mock.baseUrl}/repositories/9/commits?per_page=${perPage}&page=${pageNo + 1}>; rel="next"`,
      });
    }
    const pageNo = Number(url.searchParams.get("page") ?? "1");
    const perPage = Number(url.searchParams.get("per_page") ?? "30");
    const start = (pageNo - 1) * perPage;
    const ids = Array.from(
      { length: Math.max(0, Math.min(perPage, TOTAL - start)) },
      (_, i) => start + i + 1,
    );
    if (mode === "duplicate" && pageNo === 2) ids.unshift(perPage);
    const last = start + perPage >= TOTAL;
    const nextParams =
      pageNo === 1
        ? `per_page=${perPage}&after=Y3Vyc29yOnYyOpK0&page=2`
        : `per_page=${perPage}&page=${pageNo + 1}`;
    const linkParts = [
      ...(last
        ? []
        : [
            `<${mock.baseUrl}/repositories/123/issues?state=all&${nextParams}>; rel="next"`,
            `<${mock.baseUrl}/repositories/123/issues?state=all&per_page=${perPage}&page=3>; rel="last"`,
          ]),
      ...(pageNo > 1
        ? [
            `<${mock.baseUrl}/repositories/123/issues?state=all&per_page=${perPage}&page=${pageNo - 1}>; rel="prev"`,
          ]
        : []),
    ];
    return send(
      res,
      200,
      ids.map(item),
      linkParts.length > 0 ? { link: linkParts.join(", ") } : {},
    );
  });
  const [connector] = await testDb.db
    .insert(connectors)
    .values({
      tenant_id: tenantId,
      slug: "github-like",
      display_name: "GitHub-like",
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: mock.baseUrl,
      config: {},
    })
    .returning();
  if (!connector) throw new Error("connector insert failed");
  connectorId = connector.id;
});

afterAll(async () => {
  await mock.close();
  await testDb.cleanup();
});

beforeEach(() => {
  hits = [];
  mode = "link";
  limitedOnce = false;
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
      step_key: "issues",
      step_index: 0,
      kind: "request",
      status: "running",
      started_at: new Date(TEST_NOW_MS),
    })
    .returning({ id: executionSteps.id });
  if (!stepRow) throw new Error("step row insert failed");
  return { execution_id: exec.id, step_row_id: stepRow.id };
}

function issuesStep(pagination: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return RequestStepSchema.parse({
    id: "issues",
    kind: "request",
    connector_id: "00000000-0000-4000-8000-000000000000",
    method: "GET",
    path: "/repos/o/r/issues",
    query: { state: "all" },
    side_effects: "read",
    max_retries: 2,
    pagination: {
      strategy: "link",
      link_params: ["after", "page"],
      limit_param: "per_page",
      page_size: 100,
      max_pages: 20,
      ...pagination,
    },
    boundary: { variables: {}, max_body_bytes: 0, max_calls: 20 },
    ...extra,
  });
}

async function run(step: RequestStep, context: Partial<StepRunContext> = {}) {
  const { execution_id, step_row_id } = await createExecutionRow();
  const bound = { ...step, connector_id: connectorId };
  const ctx: StepRunContext = {
    db: testDb.db,
    tenant_id: tenantId,
    execution_id,
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
    step: bound,
    step_index: 0,
    step_row_id,
    persist_workflow_refs: true,
    llm_budget: new RunLlmBudget(null),
    ...context,
  };
  const result = await runRequestStep({ ctx, step: bound, scope: {} });
  const audit = await testDb.db
    .select({ metadata: auditLog.metadata })
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, tenantId), eq(auditLog.action, "connector.invoked")))
    .orderBy(asc(auditLog.ts));
  const invoked = audit
    .map((row) => row.metadata as { execution_id?: string; path?: string })
    .filter((meta) => meta.execution_id === execution_id);
  return { result, invoked };
}

const ids = (output: unknown) => (output as Array<{ id: number }>).map((row) => row.id);
const paginationOf = (meta: unknown) => (meta as { pagination?: unknown } | null)?.pagination;

describe("REST link pagination through the request step", () => {
  test("reads 100+100+37 items over three pages inside the declared boundary", async () => {
    const { result, invoked } = await run(issuesStep());
    expect(result.status).toBe("succeeded");
    expect(ids(result.output)).toEqual(Array.from({ length: TOTAL }, (_, i) => i + 1));
    expect(new Set(ids(result.output)).size).toBe(TOTAL);
    expect(hits).toEqual([
      "/repos/o/r/issues?state=all&per_page=100",
      "/repos/o/r/issues?state=all&per_page=100&after=Y3Vyc29yOnYyOpK0&page=2",
      "/repos/o/r/issues?state=all&per_page=100&page=3",
    ]);
    expect(invoked).toHaveLength(3);
    expect(result.warnings ?? []).toEqual([]);
    expect(paginationOf(result.request_meta)).toEqual({
      strategy: "link",
      pages: 3,
      items: TOTAL,
      duplicates_dropped: 0,
      complete: true,
      truncated: false,
      limit: null,
    });
    expect(envelopeFor({ result, scope_value: result.output }).pagination).toEqual({
      pages: 3,
      items: TOTAL,
      duplicates_dropped: 0,
      complete: true,
      truncated: false,
    });
  });

  test("a page limit without on_limit fails closed with pagination_limit_reached", async () => {
    const { result } = await run(issuesStep({ max_pages: 2 }));
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("pagination_limit_reached");
    expect(result.error?.message).toContain("max_pages=2");
    expect(hits).toHaveLength(2);
    expect(paginationOf(result.request_meta)).toMatchObject({
      pages: 2,
      complete: false,
      truncated: false,
      limit: "max_pages",
    });
  });

  test("on_limit truncate keeps the prefix and says so explicitly", async () => {
    const { result } = await run(issuesStep({ max_pages: 2, on_limit: "truncate" }));
    expect(result.status).toBe("succeeded");
    expect(ids(result.output)).toHaveLength(200);
    expect(result.warnings?.map((warning) => warning.code)).toEqual(["pagination_truncated"]);
    expect(paginationOf(result.request_meta)).toMatchObject({
      pages: 2,
      items: 200,
      complete: false,
      truncated: true,
      limit: "max_pages",
    });
    expect(envelopeFor({ result, scope_value: result.output }).pagination).toMatchObject({
      truncated: true,
      complete: false,
    });
  });

  test("max_items stops after the item limit", async () => {
    const { result } = await run(issuesStep({ max_items: 150, on_limit: "truncate" }));
    expect(result.status).toBe("succeeded");
    expect(ids(result.output)).toEqual(Array.from({ length: 150 }, (_, i) => i + 1));
    expect(hits).toHaveLength(2);
    expect(paginationOf(result.request_meta)).toMatchObject({
      truncated: true,
      limit: "max_items",
    });
    const failing = await run(issuesStep({ max_items: 150 }));
    expect(failing.result.error?.code).toBe("pagination_limit_reached");
  });

  test("unique_by drops a repeated row and counts it", async () => {
    mode = "duplicate";
    const { result } = await run(issuesStep({ unique_by: "id" }));
    expect(result.status).toBe("succeeded");
    expect(ids(result.output)).toEqual(Array.from({ length: TOTAL }, (_, i) => i + 1));
    expect(paginationOf(result.request_meta)).toMatchObject({
      duplicates_dropped: 1,
      complete: true,
    });
  });

  test("a clamped page-number read fails closed instead of ending early", async () => {
    const step = RequestStepSchema.parse({
      id: "commits",
      kind: "request",
      connector_id: "00000000-0000-4000-8000-000000000000",
      method: "GET",
      path: "/repos/o/r/commits",
      side_effects: "read",
      pagination: {
        strategy: "page",
        page_param: "page",
        limit_param: "per_page",
        page_size: 100,
        start_page: 1,
        max_pages: 10,
      },
    });
    const { result } = await run(step);
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("pagination_short_page");
    expect(hits).toHaveLength(1);
  });

  test("two runs give identical output, warnings and request order", async () => {
    const first = await run(issuesStep({ max_pages: 2, on_limit: "truncate", unique_by: "id" }));
    const firstHits = [...hits];
    hits = [];
    const second = await run(issuesStep({ max_pages: 2, on_limit: "truncate", unique_by: "id" }));
    expect(second.result.output).toEqual(first.result.output);
    expect(second.result.warnings).toEqual(first.result.warnings);
    expect(paginationOf(second.result.request_meta)).toEqual(
      paginationOf(first.result.request_meta),
    );
    expect(hits).toEqual(firstHits);
    expect(second.invoked.map((row) => row.path)).toEqual(first.invoked.map((row) => row.path));
  });

  test("a plain request without pagination carries no pagination fields", async () => {
    const step = RequestStepSchema.parse({
      id: "plain",
      kind: "request",
      connector_id: "00000000-0000-4000-8000-000000000000",
      method: "GET",
      path: "/repos/o/r/issues",
      query: { per_page: "5" },
    });
    const { result } = await run(step);
    expect(result.status).toBe("succeeded");
    expect(ids(result.output)).toEqual([1, 2, 3, 4, 5]);
    expect(result.request_meta && "pagination" in result.request_meta).toBe(false);
    expect(result.request_meta && "pages_fetched" in result.request_meta).toBe(false);
    expect("pagination" in envelopeFor({ result, scope_value: result.output })).toBe(false);
  });
});

describe("GitHub rate limits through the request step", () => {
  const clock = () => {
    const waits: number[] = [];
    return {
      waits,
      now: () => TEST_NOW_MS,
      sleep: async (ms: number) => {
        waits.push(ms);
      },
    };
  };

  test("an exhausted primary limit waits until reset and then reads every page", async () => {
    mode = "primary_limit";
    const seam = clock();
    const { result } = await withRateLimitClockForTests(seam, () => run(issuesStep()));
    expect(result.status).toBe("succeeded");
    expect(ids(result.output)).toHaveLength(TOTAL);
    expect(seam.waits).toEqual([(Math.floor(TEST_NOW_MS / 1000) + 2) * 1000 - TEST_NOW_MS + 1000]);
  });

  test("a body-only secondary limit waits at least one minute", async () => {
    mode = "secondary_limit";
    const seam = clock();
    const { result } = await withRateLimitClockForTests(seam, () =>
      run(issuesStep({}, { timeout_ms: 5 * 60_000 })),
    );
    expect(result.status).toBe("succeeded");
    expect(seam.waits).toEqual([60_000]);
  });

  test("a secondary limit that outlasts the step deadline fails as a rate limit", async () => {
    mode = "secondary_limit";
    const seam = clock();
    const { result } = await withRateLimitClockForTests(seam, () =>
      run(issuesStep({}, { timeout_ms: 30_000 })),
    );
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("upstream_rate_limited");
    expect(result.error?.health).toBe("rate_limited");
    expect(seam.waits).toEqual([]);
    expect(hits).toHaveLength(1);
  });

  test("a reset beyond the deadline fails without further requests", async () => {
    mode = "long_limit";
    const seam = clock();
    const { result } = await withRateLimitClockForTests(seam, () =>
      run(issuesStep({}, { timeout_ms: 120_000 })),
    );
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("upstream_rate_limited");
    expect(result.error?.health).toBe("rate_limited");
    expect(result.error?.health).not.toBe("auth_failed");
    expect(hits).toHaveLength(1);
  });

  test("a wait past the workflow deadline ends the step as a rate limit without sleeping", async () => {
    mode = "secondary_limit";
    const seam = clock();
    const { result } = await withRateLimitClockForTests(seam, () =>
      run(issuesStep(), { workflow_deadline_ms: TEST_NOW_MS + 30_000 }),
    );
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("upstream_rate_limited");
    expect(result.error?.health).toBe("rate_limited");
    expect(result.error?.message).toContain("workflow deadline");
    expect(seam.waits).toEqual([]);
    expect(hits).toHaveLength(1);
  });

  test("a wait inside the workflow deadline still waits and reads every page", async () => {
    mode = "secondary_limit";
    const seam = clock();
    const { result } = await withRateLimitClockForTests(seam, () =>
      run(issuesStep(), { workflow_deadline_ms: TEST_NOW_MS + 5 * 60_000 }),
    );
    expect(result.status).toBe("succeeded");
    expect(ids(result.output)).toHaveLength(TOTAL);
    expect(seam.waits).toEqual([60_000]);
  });

  test("the step deadline still binds when it ends before the workflow deadline", async () => {
    mode = "secondary_limit";
    const seam = clock();
    const { result } = await withRateLimitClockForTests(seam, () =>
      run(issuesStep({}, { timeout_ms: 30_000 }), {
        workflow_deadline_ms: TEST_NOW_MS + 60 * 60_000,
      }),
    );
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("upstream_rate_limited");
    expect(result.error?.message).toContain("step deadline");
    expect(seam.waits).toEqual([]);
  });
});
