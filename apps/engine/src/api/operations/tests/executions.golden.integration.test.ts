import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../../auth/types.ts";
import {
  getExecutionTool,
  listExecutionsTool,
} from "../../../conversations/tools/engine-api/executions.ts";
import type { ToolContext } from "../../../conversations/tools/index.ts";
import {
  auditLog,
  executionSteps,
  executions,
  externalCallMetering,
  llmUsage,
  users,
} from "../../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../../../http/tests/setup.ts";
import { currentMonthBucket } from "../../../llm/accounting/budget.ts";
import { createDeterministicHexFactory } from "../../../test-helpers/determinism/ids.ts";
import { emptyRoleId } from "../../../test-helpers/roles.ts";
import { makeToolCtx, seedTimestamp, seedUuid, seedWorkflow } from "../../../test-helpers/seed.ts";

const GOLDEN_PATH = new URL("./fixtures/executions.golden.json", import.meta.url).pathname;
const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Record<string, string>;
const actual: Record<string, string> = {};

let ctx: HttpTestServer;
let deniedKey: string;
let deniedUserId: string;
let principal: ResolvedPrincipal;
let workflowA: string;
let workflowB: string;
const MISSING = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";
const SENSITIVE = { $sensitive: true, ciphertext: "AAAA", iv: "AAAA", auth_tag: "AAAA" };

function executionId(n: number): string {
  return `5eed00e0-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

function stepId(n: number): string {
  return `5eed00e1-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

const SUCCEEDED = executionId(1);
const FAILED = executionId(2);
const OTHER_WORKFLOW = executionId(3);
const QUEUED = executionId(4);
const RUNNING = executionId(5);
const SENSITIVE_INPUT = executionId(6);
const PRODUCT_SCOPED = executionId(7);

function normalize(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll(ctx.tenantId, "<tenant>")
    .replace(/"20(2[4-9]|[3-9]\d)-\d\d-\d\dT[\d:.]+Z"/g, '"<now>"')
    .replace(/"trace_id":"[^"]*"/g, '"trace_id":"<trace>"')
    .replace(/"request_id":"[^"]*"/g, '"request_id":"<request>"')
    .replace(/"audit_trace_id":"[^"]*"/g, '"audit_trace_id":"<trace>"')
    .replace(
      /\b(?!5eed|0f0f0f0f)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g,
      "<uuid>",
    );
}

function record(name: string, value: unknown): void {
  actual[name] = normalize(value);
  expect(actual[name]).toBe(golden[name] as string);
}

async function http(
  method: string,
  path: string,
  key = ctx.apiKey,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${ctx.baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function toolCtx(withPrincipal = true): ToolContext {
  return makeToolCtx({
    db: ctx.db,
    tenant_id: ctx.tenantId,
    principal: withPrincipal ? principal : null,
  });
}

async function auditFor(resourceIds: string[]) {
  return ctx.db
    .select({
      action: auditLog.action,
      actor_type: auditLog.actor_type,
      resource_type: auditLog.resource_type,
      resource_id: auditLog.resource_id,
      result: auditLog.result,
      reason: auditLog.reason,
      metadata: auditLog.metadata,
    })
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, ctx.tenantId), inArray(auditLog.resource_id, resourceIds)))
    .orderBy(asc(auditLog.resource_id), asc(auditLog.ts), asc(auditLog.action));
}

beforeAll(async () => {
  ctx = await createHttpTestServer("operations_executions_golden");
  principal = {
    tenant_id: ctx.tenantId,
    id: "5eed00e2-0000-4000-8000-000000000001",
    kind: "user",
    provider: "test",
    roles: ["admin"],
  };
  const a = await seedWorkflow(ctx.db, {
    tenant_id: ctx.tenantId,
    id: seedUuid("workflow", 1),
    created_at: seedTimestamp(1),
    updated_at: seedTimestamp(1),
    version: { id: seedUuid("workflow_version", 1), created_at: seedTimestamp(1) },
    slug: "orders-sync",
    name: "Orders sync",
  });
  const b = await seedWorkflow(ctx.db, {
    tenant_id: ctx.tenantId,
    id: seedUuid("workflow", 2),
    created_at: seedTimestamp(2),
    updated_at: seedTimestamp(2),
    version: { id: seedUuid("workflow_version", 2), created_at: seedTimestamp(2) },
    slug: "daily-report",
    name: "Daily report",
  });
  workflowA = a.workflow.id;
  workflowB = b.workflow.id;
  const base = {
    tenant_id: ctx.tenantId,
    request_source: "api",
    execution_mode: "prod" as const,
  };
  const onA = { ...base, workflow_id: workflowA, workflow_version_id: a.version.id };
  const onB = { ...base, workflow_id: workflowB, workflow_version_id: b.version.id };
  await ctx.db.insert(executions).values([
    {
      ...onA,
      id: SUCCEEDED,
      status: "succeeded",
      input: { order: 1 },
      started_at: seedTimestamp(10),
      finished_at: seedTimestamp(11),
      created_at: seedTimestamp(10),
    },
    {
      ...onA,
      id: FAILED,
      status: "failed",
      input: { order: 2 },
      failure: { step_id: "noop", error_code: "upstream_500", error_message: "boom" },
      started_at: seedTimestamp(12),
      finished_at: seedTimestamp(13),
      created_at: seedTimestamp(12),
    },
    {
      ...onB,
      id: OTHER_WORKFLOW,
      status: "succeeded",
      request_source: "cli",
      started_at: seedTimestamp(14),
      finished_at: seedTimestamp(15),
      created_at: seedTimestamp(14),
    },
    {
      ...onA,
      id: QUEUED,
      status: "queued",
      created_at: seedTimestamp(16),
    },
    {
      ...onA,
      id: RUNNING,
      status: "running",
      started_at: seedTimestamp(17),
      created_at: seedTimestamp(17),
    },
    {
      ...onB,
      id: SENSITIVE_INPUT,
      status: "succeeded",
      input: SENSITIVE,
      started_at: seedTimestamp(18),
      finished_at: seedTimestamp(19),
      created_at: seedTimestamp(18),
    },
    {
      ...onB,
      id: PRODUCT_SCOPED,
      status: "succeeded",
      caller_context: {
        tenantId: ctx.tenantId,
        principalId: "5eed00e2-0000-4000-8000-000000000002",
        principalKind: "user",
        provider: "test",
        productId: "harmoniqs",
      },
      started_at: seedTimestamp(20),
      finished_at: seedTimestamp(21),
      created_at: seedTimestamp(20),
    },
  ]);
  await ctx.db.insert(executionSteps).values([
    {
      id: stepId(1),
      tenant_id: ctx.tenantId,
      execution_id: SUCCEEDED,
      step_key: "noop",
      step_index: 0,
      kind: "transform",
      status: "succeeded",
      held: false,
      duration_ms: 12,
      output_preview: { ok: true },
      started_at: seedTimestamp(10),
      finished_at: seedTimestamp(11),
    },
    {
      id: stepId(2),
      tenant_id: ctx.tenantId,
      execution_id: SUCCEEDED,
      step_key: "write",
      step_index: 1,
      kind: "request",
      status: "succeeded",
      held: true,
      duration_ms: 3,
      started_at: seedTimestamp(11),
      finished_at: seedTimestamp(11),
    },
    {
      id: stepId(3),
      tenant_id: ctx.tenantId,
      execution_id: FAILED,
      step_key: "noop",
      step_index: 0,
      kind: "transform",
      status: "failed",
      held: false,
      error: { code: "upstream_500" },
      started_at: seedTimestamp(12),
      finished_at: seedTimestamp(13),
    },
  ]);
  const month_bucket = currentMonthBucket();
  await ctx.db.insert(llmUsage).values([
    {
      tenant_id: ctx.tenantId,
      flow: "generate",
      model: "claude-haiku-4-5",
      prompt_tokens: 200,
      completion_tokens: 50,
      cache_read_tokens: 100,
      cache_creation_tokens: 0,
      total_tokens: 215,
      latency_ms: 300,
      result: "success",
      month_bucket,
      execution_id: SUCCEEDED,
    },
    {
      tenant_id: ctx.tenantId,
      flow: "repair",
      model: "claude-haiku-4-5",
      prompt_tokens: 100,
      completion_tokens: 30,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      total_tokens: 130,
      latency_ms: 200,
      result: "success",
      month_bucket,
      execution_id: SUCCEEDED,
    },
  ]);
  await ctx.db.insert(externalCallMetering).values({
    tenant_id: ctx.tenantId,
    provider: "browserless",
    operation: "crawl",
    units: 5,
    cost_usd: "0.005000",
    latency_ms: 800,
    result: "ok",
    month_bucket,
    execution_id: SUCCEEDED,
  });
  const [denied] = await ctx.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: "denied-executions@test.local",
      role_id: await emptyRoleId(ctx.db, ctx.tenantId),
    })
    .returning();
  if (!denied) throw new Error("denied user insert returned no row");
  deniedUserId = denied.id;
  const rand = createDeterministicHexFactory(0x60_1e)(16);
  deniedKey = `wf_live_${rand}`;
  await ctx.testDb.pool.query(
    "INSERT INTO subkit.api_keys (tenant_id, user_id, prefix, token_sha256, scopes) VALUES ($1, $2, $3, $4, $5::jsonb)",
    [
      ctx.tenantId,
      denied.id,
      deniedKey.slice(0, 12),
      createHash("sha256").update(deniedKey).digest("hex"),
      JSON.stringify(["*"]),
    ],
  );
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("execution read operations keep their HTTP responses byte for byte", () => {
  test("list", async () => {
    record("http.list", await http("GET", "/v1/executions"));
    const first = await http("GET", "/v1/executions?limit=2");
    record("http.list.page", first);
    const cursor = (first.body as { next_cursor: string }).next_cursor;
    record(
      "http.list.cursor",
      await http("GET", `/v1/executions?limit=2&cursor=${encodeURIComponent(cursor)}`),
    );
    record("http.list.statuses", await http("GET", "/v1/executions?status=failed,queued"));
    record("http.list.workflow", await http("GET", `/v1/executions?workflow_id=${workflowB}`));
    record("http.list.source", await http("GET", "/v1/executions?request_source=cli"));
    record("http.list.held", await http("GET", "/v1/executions?held_effects=true"));
    record(
      "http.list.window",
      await http(
        "GET",
        `/v1/executions?started_from=${seedTimestamp(12).toISOString()}&started_to=${seedTimestamp(17).toISOString()}`,
      ),
    );
    record("http.list.bad-cursor", await http("GET", "/v1/executions?cursor=page-2"));
    record("http.list.invalid", await http("GET", "/v1/executions?limit=0"));
  });

  test("get", async () => {
    record("http.get", await http("GET", `/v1/executions/${SUCCEEDED}`));
    record("http.get.failed", await http("GET", `/v1/executions/${FAILED}`));
    record("http.get.sensitive", await http("GET", `/v1/executions/${SENSITIVE_INPUT}`));
    record("http.get.product", await http("GET", `/v1/executions/${PRODUCT_SCOPED}`));
    record("http.get.missing", await http("GET", `/v1/executions/${MISSING}`));
    record("http.get.invalid", await http("GET", "/v1/executions/not-a-uuid"));
  });

  test("steps", async () => {
    record("http.steps", await http("GET", `/v1/executions/${SUCCEEDED}/steps`));
    record("http.steps.failed", await http("GET", `/v1/executions/${FAILED}/steps`));
    record("http.steps.empty", await http("GET", `/v1/executions/${QUEUED}/steps`));
    record("http.steps.missing", await http("GET", `/v1/executions/${MISSING}/steps`));
    record("http.steps.invalid", await http("GET", "/v1/executions/not-a-uuid/steps"));
  });

  test("cost", async () => {
    record("http.cost", await http("GET", `/v1/executions/${SUCCEEDED}/cost`));
    record("http.cost.empty", await http("GET", `/v1/executions/${FAILED}/cost`));
    record("http.cost.missing", await http("GET", `/v1/executions/${MISSING}/cost`));
    record("http.cost.invalid", await http("GET", "/v1/executions/not-a-uuid/cost"));
  });

  test("permission is checked before the input is validated", async () => {
    record("http.denied.list", await http("GET", "/v1/executions", deniedKey));
    record("http.denied.list.invalid", await http("GET", "/v1/executions?limit=0", deniedKey));
    record("http.denied.get", await http("GET", `/v1/executions/${SUCCEEDED}`, deniedKey));
    record("http.denied.steps", await http("GET", `/v1/executions/${SUCCEEDED}/steps`, deniedKey));
    record("http.denied.cost", await http("GET", `/v1/executions/${SUCCEEDED}/cost`, deniedKey));
    record("http.denied.cancel", await http("POST", `/v1/executions/${QUEUED}/cancel`, deniedKey));
    const trail = await ctx.db
      .select({
        action: auditLog.action,
        resource_type: auditLog.resource_type,
        resource_id: auditLog.resource_id,
        result: auditLog.result,
        reason: auditLog.reason,
        metadata: auditLog.metadata,
      })
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.actor_id, deniedUserId)))
      .orderBy(asc(auditLog.ts), asc(auditLog.action));
    record("http.denied.audit", trail);
  });
});

describe("execution tools keep their results byte for byte", () => {
  test("list_executions", async () => {
    record("tool.list", await listExecutionsTool.execute(toolCtx(), {}));
    const first = await listExecutionsTool.execute(toolCtx(), { limit: 2 });
    record("tool.list.page", first);
    const cursor = (first.data as { next_cursor: string }).next_cursor;
    record("tool.list.cursor", await listExecutionsTool.execute(toolCtx(), { limit: 2, cursor }));
    record("tool.list.status", await listExecutionsTool.execute(toolCtx(), { status: "failed" }));
    record(
      "tool.list.workflow",
      await listExecutionsTool.execute(toolCtx(), { workflow_id: workflowB }),
    );
    record(
      "tool.list.source",
      await listExecutionsTool.execute(toolCtx(), { request_source: "cli" }),
    );
    record(
      "tool.list.window",
      await listExecutionsTool.execute(toolCtx(), {
        started_from: seedTimestamp(12).toISOString(),
        started_to: seedTimestamp(17).toISOString(),
      }),
    );
    record("tool.list.no-principal", await listExecutionsTool.execute(toolCtx(false), {}));
  });

  test("get_execution", async () => {
    record("tool.get", await getExecutionTool.execute(toolCtx(), { id: SUCCEEDED }));
    record("tool.get.failed", await getExecutionTool.execute(toolCtx(), { id: FAILED }));
    record(
      "tool.get.sensitive",
      await getExecutionTool.execute(toolCtx(), { id: SENSITIVE_INPUT }),
    );
    record("tool.get.product", await getExecutionTool.execute(toolCtx(), { id: PRODUCT_SCOPED }));
    record("tool.get.missing", await getExecutionTool.execute(toolCtx(), { id: MISSING }));
    record(
      "tool.get.no-principal",
      await getExecutionTool.execute(toolCtx(false), { id: SUCCEEDED }),
    );
  });

  test("tool definitions", () => {
    record("tool.list.definition", {
      name: listExecutionsTool.name,
      description: listExecutionsTool.description,
      category: listExecutionsTool.category,
      strict: listExecutionsTool.strict ?? null,
      permission: listExecutionsTool.permission ?? null,
    });
    record("tool.get.definition", {
      name: getExecutionTool.name,
      description: getExecutionTool.description,
      category: getExecutionTool.category,
      strict: getExecutionTool.strict ?? null,
      permission: getExecutionTool.permission ?? null,
    });
  });
});

describe("cancel keeps its HTTP responses and audit trail", () => {
  test("cancel", async () => {
    record("http.cancel.queued", await http("POST", `/v1/executions/${QUEUED}/cancel`));
    record("http.cancel.running", await http("POST", `/v1/executions/${RUNNING}/cancel`));
    record("http.cancel.finished", await http("POST", `/v1/executions/${SUCCEEDED}/cancel`));
    record("http.cancel.product", await http("POST", `/v1/executions/${PRODUCT_SCOPED}/cancel`));
    record("http.cancel.missing", await http("POST", `/v1/executions/${MISSING}/cancel`));
    record("http.cancel.invalid", await http("POST", "/v1/executions/not-a-uuid/cancel"));
    const rows = await ctx.db
      .select({ id: executions.id, status: executions.status })
      .from(executions)
      .where(
        and(
          eq(executions.tenant_id, ctx.tenantId),
          inArray(executions.id, [QUEUED, RUNNING, SUCCEEDED]),
        ),
      )
      .orderBy(asc(executions.id));
    record("http.cancel.rows", rows);
    record("http.cancel.audit", await auditFor([QUEUED, RUNNING, SUCCEEDED, PRODUCT_SCOPED]));
  });

  test("the golden file has no stale entries", () => {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(golden).sort());
  });
});
