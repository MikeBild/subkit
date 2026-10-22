import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { ServerResponse } from "node:http";
import { and, eq } from "drizzle-orm";
import { auditLog, connectors, executionSteps } from "../../db/schema/index.ts";
import { logRing } from "../../observability/log-ring.ts";
import { runExecution } from "../engine.ts";
import { sensitiveFailure } from "../sensitive-payload.ts";
import {
  createEngineCtx,
  createMockServer,
  createWorkflowRow,
  type EngineTestCtx,
  type MockServer,
} from "./setup.ts";

const CURSOR = "PRIVATECURSORcanary";
const QUERY_VALUE = "PRIVATEQUERYcanary";
const PAGES = 51;

let ctx: EngineTestCtx;
let mock: MockServer;
let hits = 0;
let connectorId: string;

function send(res: ServerResponse, body: unknown, link?: string) {
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  if (link) res.setHeader("link", link);
  res.end(JSON.stringify(body));
}

beforeAll(async () => {
  ctx = await createEngineCtx("sensitive-pagination");
  mock = await createMockServer((req, res) => {
    hits += 1;
    const url = new URL(req.url ?? "/", "http://mock");
    const page = Number(url.searchParams.get("page") ?? "1");
    const next =
      page < PAGES
        ? `<${mock.baseUrl}/items?label=${QUERY_VALUE}&per_page=2&after=${CURSOR}${page}&page=${page + 1}>; rel="next"`
        : undefined;
    send(
      res,
      [
        { id: page * 2 - 1, title: "PRIVATE-ROW" },
        { id: page * 2, title: "PRIVATE-ROW" },
      ],
      next,
    );
  });
  const [connector] = await ctx.testDb.db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenantId,
      slug: "sensitive-paging",
      display_name: "Sensitive paging",
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
  await ctx.cleanup();
});

beforeEach(() => {
  hits = 0;
});

function pagedStep(pagination: Record<string, unknown>) {
  return {
    id: "items",
    kind: "request",
    method: "GET",
    url: `${mock.baseUrl}/items`,
    query: { label: QUERY_VALUE },
    side_effects: "read",
    max_retries: 0,
    pagination: {
      strategy: "link",
      link_params: ["after", "page"],
      limit_param: "per_page",
      page_size: 2,
      ...pagination,
    },
  };
}

async function runSensitive(slug: string, steps: unknown[]) {
  const { workflow_id } = await createWorkflowRow(ctx, {
    name: slug,
    slug,
    execution_privacy: "sensitive",
    steps,
  });
  const logs: unknown[] = [];
  const unsubscribe = logRing.subscribe((entry) => logs.push(entry));
  const result = await runExecution({
    db: ctx.testDb.db,
    tenant_id: ctx.tenantId,
    source: { kind: "saved", workflow_id },
    input: {},
  }).finally(unsubscribe);
  const steps_rows = await ctx.testDb.db
    .select()
    .from(executionSteps)
    .where(
      and(
        eq(executionSteps.tenant_id, ctx.tenantId),
        eq(executionSteps.execution_id, result.execution_id),
      ),
    );
  return { result, logs: JSON.stringify(logs), rows: steps_rows };
}

test("a sensitive paginated read is admitted and leaves no checkpoint, cursor or query value", async () => {
  const { result, logs, rows } = await runSensitive("sensitive-pages", [
    pagedStep({ max_pages: 60 }),
    {
      id: "count",
      kind: "transform",
      language: "javascript",
      expression:
        "return { count: input.scope.items.data.length, complete: input.scope.items.pagination.complete };",
    },
  ]);
  expect(result.status).toBe("succeeded");
  expect(hits).toBe(PAGES);
  expect(result.output).toEqual({ count: PAGES * 2, complete: true });
  expect(JSON.stringify(rows)).not.toContain("pagination_checkpoint");
  expect(JSON.stringify(rows)).not.toContain(CURSOR);
  expect(logs).not.toContain(CURSOR);
  expect(logs).not.toContain(QUERY_VALUE);
  expect(logs).not.toContain("PRIVATE-ROW");
});

test("a sensitive paginated read through a connector audits each page without query values", async () => {
  const { url: _url, ...step } = pagedStep({ max_pages: 60 });
  const { result, logs } = await runSensitive("sensitive-pages-connector", [
    { ...step, connector_id: connectorId, path: "/items" },
  ]);
  expect(result.status).toBe("succeeded");
  const audit = await ctx.testDb.db
    .select({ metadata: auditLog.metadata, reason: auditLog.reason })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, ctx.tenantId),
        eq(auditLog.action, "connector.invoked"),
        eq(auditLog.resource_id, connectorId),
      ),
    );
  const rows = audit.filter(
    (row) => (row.metadata as { execution_privacy?: string }).execution_privacy === "sensitive",
  );
  expect(rows).toHaveLength(PAGES);
  expect(JSON.stringify(rows)).not.toContain(CURSOR);
  expect(JSON.stringify(rows)).not.toContain(QUERY_VALUE);
  expect(logs).not.toContain(CURSOR);
  expect(logs).not.toContain(QUERY_VALUE);
});

test("a sensitive limit failure keeps its safe code at step and run level", async () => {
  const { result } = await runSensitive("sensitive-pages-limit", [pagedStep({ max_pages: 3 })]);
  expect(result.status).toBe("failed");
  expect(result.error).toEqual(sensitiveFailure("pagination_limit_reached"));
  expect(result.error?.code).toBe("pagination_limit_reached");
  expect(result.steps[0]?.error).toEqual(sensitiveFailure("pagination_limit_reached"));
  expect(JSON.stringify(result)).not.toContain(CURSOR);
});

test("a sensitive truncation surfaces as a fixed warning in the run result", async () => {
  const { result } = await runSensitive("sensitive-pages-truncate", [
    pagedStep({ max_pages: 3, on_limit: "truncate" }),
  ]);
  expect(result.status).toBe("succeeded");
  expect(result.warnings).toEqual([
    {
      code: "pagination_truncated",
      step_key: "items",
      message: sensitiveFailure("pagination_truncated").message,
    },
  ]);
  expect(JSON.stringify(result)).not.toContain(CURSOR);
  expect(JSON.stringify(result)).not.toContain(QUERY_VALUE);
});

test("sensitive runs still refuse persistent state", async () => {
  const { workflow_id } = await createWorkflowRow(ctx, {
    name: "sensitive-state",
    slug: "sensitive-state",
    execution_privacy: "sensitive",
    steps: [{ ...pagedStep({ max_pages: 3 }), state_write: { key: "cursor", value_path: "$.id" } }],
  });
  await expect(
    runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: {},
    }),
  ).rejects.toMatchObject({ code: "sensitive_execution_unsupported" });
});

test("each new safe code has a fixed sentence without response data", () => {
  for (const code of [
    "pagination_limit_reached",
    "pagination_link_foreign",
    "pagination_link_unsupported",
    "pagination_link_loop",
    "pagination_short_page",
    "upstream_rate_limited",
    "graphql_endpoint_invalid",
    "graphql_path_required",
  ]) {
    const failure = sensitiveFailure(code);
    expect(failure.code).toBe(code);
    expect(failure.message).not.toBe("Sensitive execution failed.");
    expect(failure.message.length).toBeGreaterThan(20);
  }
});
