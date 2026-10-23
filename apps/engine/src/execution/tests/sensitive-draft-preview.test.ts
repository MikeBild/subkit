import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog, executionSteps, executions } from "../../db/schema/index.ts";
import { logRing } from "../../observability/log-ring.ts";
import type { WorkflowDef } from "../../workflows/types.ts";
import { runExecution } from "../engine.ts";
import { isSensitivePayload } from "../sensitive-payload.ts";
import {
  createEngineCtx,
  createMockServer,
  createWorkflowRow,
  type EngineTestCtx,
  jsonResponse,
  type MockServer,
} from "./setup.ts";

const PLANTED = "PLANTED-sensitive-preview-canary";

let ctx: EngineTestCtx;
let mock: MockServer;

beforeAll(async () => {
  ctx = await createEngineCtx("sensitive-draft-preview");
  mock = await createMockServer((req, res) => {
    if (req.method !== "GET") return jsonResponse(res, 500, { error: "write dispatched" });
    jsonResponse(res, 200, { items: [{ name: PLANTED }, { name: PLANTED }], total: 2 });
  });
});

afterAll(async () => {
  await mock.close();
  await ctx.cleanup();
});

function definition(overrides: Partial<WorkflowDef> = {}): WorkflowDef {
  return {
    name: "Private preview",
    slug: "private-preview",
    execution_privacy: "sensitive",
    output_schema: {
      type: "object",
      properties: { names: { type: "array" }, count: { type: "number" } },
      required: ["names", "count"],
    },
    validation_function: "return input.count > 0;",
    steps: [
      {
        id: "read",
        kind: "request",
        method: "GET",
        url: `${mock.baseUrl}/items`,
        side_effects: "read",
        max_retries: 0,
      },
      {
        id: "shape",
        kind: "transform",
        language: "javascript",
        expression:
          "const items = input.scope.read.data.items; return { names: items.map((i) => i.name), count: items.length, secret: items[0].name };",
      },
    ],
    ...overrides,
  } as WorkflowDef;
}

function refusalCode(error: unknown): unknown {
  return (error as { code?: unknown }).code;
}

test("a sensitive chat draft run without the metadata preview option stays refused", async () => {
  const refused = await runExecution({
    db: ctx.testDb.db,
    tenant_id: ctx.tenantId,
    source: { kind: "draft", definition: definition() },
    input: {},
    options: { request_source: "chat", hold_writes: true },
  }).catch((error: unknown) => error);
  expect(refusalCode(refused)).toBe("sensitive_execution_unsupported");
});

test("the metadata preview option requires held writes", async () => {
  const refused = await runExecution({
    db: ctx.testDb.db,
    tenant_id: ctx.tenantId,
    source: { kind: "draft", definition: definition() },
    input: {},
    options: { request_source: "chat", sensitive_metadata_preview: true },
  }).catch((error: unknown) => error);
  expect(refusalCode(refused)).toBe("sensitive_execution_unsupported");
});

test("a saved sensitive workflow stays refused in chat even with the metadata preview option", async () => {
  const { workflow_id } = await createWorkflowRow(ctx, definition({ slug: "private-saved" }));
  const refused = await runExecution({
    db: ctx.testDb.db,
    tenant_id: ctx.tenantId,
    source: { kind: "saved", workflow_id },
    input: {},
    options: { request_source: "chat", hold_writes: true, sensitive_metadata_preview: true },
  }).catch((error: unknown) => error);
  expect(refusalCode(refused)).toBe("sensitive_execution_unsupported");
});

test("the metadata preview refuses step fixture replay", async () => {
  const refused = await runExecution({
    db: ctx.testDb.db,
    tenant_id: ctx.tenantId,
    source: { kind: "draft", definition: definition() },
    input: {},
    options: {
      request_source: "chat",
      hold_writes: true,
      sensitive_metadata_preview: true,
      step_output_fixtures: { read: { data: { items: [] } } },
    },
  }).catch((error: unknown) => error);
  expect(refusalCode(refused)).toBe("sensitive_execution_unsupported");
});

test("a sensitive draft metadata preview runs encrypted and returns only metadata", async () => {
  const logs: unknown[] = [];
  const unsubscribe = logRing.subscribe((entry) => logs.push(entry));
  const result = await runExecution({
    db: ctx.testDb.db,
    tenant_id: ctx.tenantId,
    source: { kind: "draft", definition: definition() },
    input: {},
    options: { request_source: "chat", hold_writes: true, sensitive_metadata_preview: true },
  }).finally(unsubscribe);
  expect(result.status).toBe("succeeded");
  expect(result.output).toBeNull();
  expect(result.sensitive_checks).toEqual({
    validation: "passed",
    output_schema: "passed",
    output_shape: { names: { type: "array", length: 2 }, count: { type: "number" } },
  });
  expect(result.steps.map((step) => [step.step_key, step.status])).toEqual([
    ["read", "succeeded"],
    ["shape", "succeeded"],
  ]);
  expect(JSON.stringify(result)).not.toContain(PLANTED);
  expect(JSON.stringify(logs)).not.toContain(PLANTED);
  const [row] = await ctx.testDb.db
    .select()
    .from(executions)
    .where(and(eq(executions.tenant_id, ctx.tenantId), eq(executions.id, result.execution_id)));
  expect(isSensitivePayload(row?.input)).toBe(true);
  expect(row?.hold_writes).toBe(true);
  expect(JSON.stringify(row)).not.toContain(PLANTED);
  const stepRows = await ctx.testDb.db
    .select()
    .from(executionSteps)
    .where(
      and(
        eq(executionSteps.tenant_id, ctx.tenantId),
        eq(executionSteps.execution_id, result.execution_id),
      ),
    );
  expect(stepRows.length).toBeGreaterThan(0);
  expect(JSON.stringify(stepRows)).not.toContain(PLANTED);
  const audit = await ctx.testDb.db
    .select({ metadata: auditLog.metadata })
    .from(auditLog)
    .where(eq(auditLog.tenant_id, ctx.tenantId));
  expect(JSON.stringify(audit)).not.toContain(PLANTED);
});

test("a sensitive draft metadata preview holds writes", async () => {
  const before = mock.callCount();
  const result = await runExecution({
    db: ctx.testDb.db,
    tenant_id: ctx.tenantId,
    source: {
      kind: "draft",
      definition: definition({
        steps: [
          ...definition().steps,
          {
            id: "send",
            kind: "request",
            method: "POST",
            url: `${mock.baseUrl}/send`,
            body: { note: "held" },
            max_retries: 0,
          },
        ],
      } as Partial<WorkflowDef>),
    },
    input: {},
    options: { request_source: "chat", hold_writes: true, sensitive_metadata_preview: true },
  });
  expect(mock.callCount() - before).toBe(1);
  expect(result.steps.find((step) => step.step_key === "send")?.held).toBe(true);
  expect(result.output).toBeNull();
  expect(JSON.stringify(result)).not.toContain(PLANTED);
});

test("a failed sensitive validation is reported without values", async () => {
  const result = await runExecution({
    db: ctx.testDb.db,
    tenant_id: ctx.tenantId,
    source: {
      kind: "draft",
      definition: definition({ validation_function: "return input.count > 5;" }),
    },
    input: {},
    options: { request_source: "chat", hold_writes: true, sensitive_metadata_preview: true },
  });
  expect(result.status).toBe("failed");
  expect(result.sensitive_checks?.validation).toBe("failed");
  expect(result.sensitive_checks?.output_schema).toBe("passed");
  expect(result.error?.code).toBe("sensitive_execution_failure");
  expect(JSON.stringify(result)).not.toContain(PLANTED);
  expect(JSON.stringify(result)).not.toContain("count > 5");
});
