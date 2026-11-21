import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { AuthProviderRegistry } from "../../auth/registry.ts";
import { executionSteps, executions } from "../../db/schema/index.ts";
import { TEST_DB_HOOK_TIMEOUT } from "../../db/tests/setup.ts";
import type { CallerContext } from "../../execution/caller-context.ts";
import { createWorkflowRow } from "../../execution/tests/setup.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;
let workflowId: string;
const inputSchema = {
  type: "object",
  required: ["context"],
  additionalProperties: false,
  properties: {
    context: {
      type: "object",
      required: ["requestId", "metadata"],
      additionalProperties: false,
      properties: {
        requestId: { type: "string", minLength: 1, maxLength: 8 },
        metadata: {
          type: "object",
          required: ["count"],
          additionalProperties: false,
          properties: { count: { type: "integer", minimum: 0, maximum: 8 } },
        },
        $caller: { type: "object" },
      },
    },
  },
};

beforeAll(async () => {
  const registry = new AuthProviderRegistry().register({
    name: "schema-test",
    capabilities: {
      human: true,
      machine: false,
      interactive: false,
      refresh: false,
      revoke: false,
    },
    async resolve(request) {
      if (request.headers.get("authorization") !== "Bearer owner") return null;
      return {
        provider: "schema-test",
        kind: "user",
        id: ctx.userId,
        tenant_id: ctx.tenantId,
        roles: ["admin"],
        product_id: "schema-product",
      };
    },
  });
  ctx = await createHttpTestServer("nested-schema-admission", { appOptions: { registry } });
  const workflow = await createWorkflowRow(ctx, {
    name: "Nested schema caller",
    slug: "nested-schema-caller",
    product_id: "schema-product",
    required_caller_kind: "user",
    input_schema: inputSchema,
    steps: [
      {
        id: "out",
        kind: "transform",
        language: "javascript",
        expression: "return { context: input.input.context, caller: input.scope.$caller };",
      },
    ],
  });
  workflowId = workflow.workflow_id;
}, TEST_DB_HOOK_TIMEOUT);

afterAll(async () => {
  if (ctx) await ctx.cleanup();
}, TEST_DB_HOOK_TIMEOUT);

async function run(input: unknown, hold_writes: boolean) {
  return fetch(`${ctx.baseUrl}/v1/executions`, {
    method: "POST",
    headers: { authorization: "Bearer owner", "content-type": "application/json" },
    body: JSON.stringify({ source: "saved", workflow_id: workflowId, input, hold_writes }),
  });
}

async function rows() {
  return ctx.db
    .select()
    .from(executions)
    .where(and(eq(executions.tenant_id, ctx.tenantId), eq(executions.workflow_id, workflowId)));
}

for (const holdWrites of [true, false]) {
  test(`nested schema rejects invalid inputs before ${holdWrites ? "preparation" : "live authority"} rows`, async () => {
    const before = (await rows()).length;
    for (const input of [
      { context: { requestId: "ok", metadata: { count: 1, unexpected: true } } },
      { context: { requestId: "ok", metadata: {} } },
      { context: { requestId: "too-long-private-value", metadata: { count: 1 } } },
      { context: { requestId: "ok", metadata: { count: 9 } } },
      { context: { requestId: "ok", metadata: { count: 1.5 } } },
      [],
      null,
    ]) {
      const response = await run(input, holdWrites);
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body).toMatchObject({ code: "input_schema_violation" });
      expect(JSON.stringify(body)).not.toContain("too-long-private-value");
      expect((await rows()).length).toBe(before);
    }
  });
}

test("schema-valid live input still requires effect authority without creating a row", async () => {
  const before = (await rows()).length;
  const response = await run({ context: { requestId: "ok", metadata: { count: 1 } } }, false);
  expect(response.status).toBe(409);
  expect((await rows()).length).toBe(before);
});

test("valid context round-trips while spoofed context identity never changes trusted caller", async () => {
  const context = {
    requestId: "Unicode",
    metadata: { count: 8 },
    $caller: { principalId: "foreign", tenantId: "foreign", productId: "foreign" },
  };
  const response = await run({ context }, true);
  expect(response.status).toBe(200);
  const [row] = await rows();
  expect(row?.status).toBe("succeeded");
  const caller = {
    tenantId: ctx.tenantId,
    principalId: ctx.userId,
    principalKind: "user",
    provider: "schema-test",
    productId: "schema-product",
  } satisfies CallerContext;
  expect(row?.caller_context).toEqual(caller);
  const steps = await ctx.db
    .select()
    .from(executionSteps)
    .where(
      and(eq(executionSteps.tenant_id, ctx.tenantId), eq(executionSteps.execution_id, row!.id)),
    );
  expect(steps).toHaveLength(1);
  expect(steps[0]?.output_preview).toEqual({ context, caller });
});

async function compatibilityWorkflow(slug: string, input_schema?: Record<string, unknown>) {
  return createWorkflowRow(ctx, {
    name: slug,
    slug,
    product_id: "schema-product",
    ...(input_schema ? { input_schema } : {}),
    steps: [{ id: "out", kind: "transform", expression: "return { value: input.input };" }],
  });
}

async function compatibilityRun(workflow_id: string, input?: unknown) {
  return fetch(`${ctx.baseUrl}/v1/executions`, {
    method: "POST",
    headers: { authorization: "Bearer owner", "content-type": "application/json" },
    body: JSON.stringify({
      source: "saved",
      workflow_id,
      hold_writes: true,
      ...(input === undefined ? {} : { input }),
    }),
  });
}

async function compatibilityRows(workflow_id: string) {
  return ctx.db
    .select()
    .from(executions)
    .where(and(eq(executions.tenant_id, ctx.tenantId), eq(executions.workflow_id, workflow_id)));
}

test("omitted optional object input defaults to an empty object while explicit null is refused", async () => {
  const workflow = await compatibilityWorkflow("optional-object-schema", {
    type: "object",
    properties: { requestId: { type: "string" } },
  });
  const omitted = await compatibilityRun(workflow.workflow_id);
  expect(omitted.status).toBe(200);
  const [row] = await compatibilityRows(workflow.workflow_id);
  expect(row?.input).toEqual({});
  expect(row?.status).toBe("succeeded");
  const explicitNull = await compatibilityRun(workflow.workflow_id, null);
  expect(explicitNull.status).toBe(400);
  expect(await explicitNull.json()).toMatchObject({ code: "input_schema_violation" });
  expect(await compatibilityRows(workflow.workflow_id)).toHaveLength(1);
});

test("omitted input still refuses required object fields before creating a row", async () => {
  const workflow = await compatibilityWorkflow("required-object-schema", {
    type: "object",
    required: ["requestId"],
    properties: { requestId: { type: "string" } },
  });
  const response = await compatibilityRun(workflow.workflow_id);
  expect(response.status).toBe(400);
  const body = (await response.json()) as { code: string; message: string };
  expect(body.code).toBe("input_schema_violation");
  expect(body.message).toContain("requestId");
  expect(await compatibilityRows(workflow.workflow_id)).toHaveLength(0);
});

test("omitted input without a declared schema retains null", async () => {
  const workflow = await compatibilityWorkflow("schema-free-input");
  const response = await compatibilityRun(workflow.workflow_id);
  expect(response.status).toBe(200);
  const [row] = await compatibilityRows(workflow.workflow_id);
  expect(row?.input).toBeNull();
  expect(row?.status).toBe("succeeded");
});

test("serialized structured input keeps its established normalization", async () => {
  const workflow = await compatibilityWorkflow("serialized-object-schema", {
    type: "object",
    required: ["requestId"],
    properties: { requestId: { type: "string" } },
  });
  const response = await compatibilityRun(
    workflow.workflow_id,
    JSON.stringify({ requestId: "unchanged" }),
  );
  expect(response.status).toBe(200);
  const [row] = await compatibilityRows(workflow.workflow_id);
  expect(row?.input).toEqual({ requestId: "unchanged" });
  expect(row?.status).toBe("succeeded");
});
