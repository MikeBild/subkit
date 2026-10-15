import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog, executionSteps, executions } from "../../db/schema/index.ts";
import { protectExecutionPayload } from "../../execution/sensitive-payload.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { type McpTestSuite, startMcpTestSuite } from "./setup.ts";

let suite: McpTestSuite;
let executionId = "";
const ALEX = "99999999-9999-4999-8999-999999999991";
const SAM = "99999999-9999-4999-8999-999999999992";
const uuid = createDeterministicUuidFactory(0x5c);

beforeAll(async () => {
  suite = await startMcpTestSuite("execution-caller-parity");
  const [row] = await suite.http.db
    .insert(executions)
    .values({
      tenant_id: suite.http.tenantId,
      status: "succeeded",
      source_kind: "draft",
      request_source: "api",
      execution_mode: "prod",
      caller_origin: "principal",
      caller_context: {
        tenantId: suite.http.tenantId,
        principalId: "77777777-7777-4777-8777-777777777777",
        principalKind: "system_account",
        provider: "api_key",
        productId: null,
      },
      authorization_context: {
        source: {
          kind: "api_key",
          api_key_id: "88888888-8888-4888-8888-888888888888",
          credential_version: "v-hidden",
        },
      },
    })
    .returning({ id: executions.id });
  executionId = row?.id ?? "";

  const entry = (actor_id: string, trace_id: string) => ({
    id: uuid(),
    tenant_id: suite.http.tenantId,
    actor_type: "user" as const,
    actor_id,
    action: "workflow.run",
    resource_type: "execution",
    result: "success" as const,
    trace_id,
  });
  await suite.http.db
    .insert(auditLog)
    .values([entry(ALEX, "trace-alex"), entry(SAM, "trace-sam"), entry(SAM, "trace-sam-2")]);
});

afterAll(async () => {
  await suite.cleanup();
});

test("HTTP and MCP tell the same story about who started a run", async () => {
  const res = await fetch(`${suite.http.baseUrl}/v1/executions/${executionId}`, {
    headers: { authorization: `Bearer ${suite.http.apiKey}` },
  });
  expect(res.status).toBe(200);
  const viaHttp = (await res.json()) as { caller: unknown } & Record<string, unknown>;

  const client = await suite.connect();
  const result = await client.callTool({ name: "get_execution", arguments: { id: executionId } });
  const content = result.content as Array<{ type: string; text: string }>;
  const viaMcp = JSON.parse(content[0]?.text ?? "null") as {
    execution: { caller: unknown } & Record<string, unknown>;
  };

  expect(viaHttp.caller).toEqual({
    kind: "system_account",
    principal_id: "77777777-7777-4777-8777-777777777777",
    provider: "api_key",
    product_id: null,
    verified_by: "api_key",
    channel: "api",
    origin_execution_id: null,
  });
  expect(viaMcp.execution.caller).toEqual(viaHttp.caller);
  for (const field of [
    "permission_basis",
    "permission_phase",
    "permission_checked_at",
    "trace_id",
  ]) {
    expect(viaHttp[field]).toBeNull();
    expect(viaMcp.execution[field]).toBeNull();
  }
  expect(viaMcp.execution.execution_environment).toBe("prod");
  expect(JSON.stringify(viaMcp)).not.toContain("v-hidden");
});

async function auditViaBoth(query: Record<string, string>) {
  const res = await fetch(
    `${suite.http.baseUrl}/v1/audit-log?${new URLSearchParams(query).toString()}`,
    { headers: { authorization: `Bearer ${suite.http.apiKey}` } },
  );
  expect(res.status).toBe(200);
  const viaHttp = (await res.json()) as { items: Array<{ id: string }> };
  const client = await suite.connect();
  const result = await client.callTool({ name: "list_audit", arguments: query });
  const content = result.content as Array<{ type: string; text: string }>;
  const viaMcp = JSON.parse(content[0]?.text ?? "null") as { entries: Array<{ id: string }> };
  return { http: viaHttp.items.map((e) => e.id), mcp: viaMcp.entries.map((e) => e.id) };
}

test("the audit trail narrows to one person the same way over HTTP and MCP", async () => {
  const { http, mcp } = await auditViaBoth({ actor_id: SAM });
  expect(mcp).toHaveLength(2);
  expect(mcp).toEqual(http);
});

test("the audit trail follows one request the same way over HTTP and MCP", async () => {
  const { http, mcp } = await auditViaBoth({ trace_id: "trace-alex" });
  expect(mcp).toHaveLength(1);
  expect(mcp).toEqual(http);
});

test("execution evidence and dispatch snapshots agree across HTTP, MCP detail, list and inspection", async () => {
  const workflow = await suite.seedWorkflow({
    slug: "evidence-parity",
    name: "Evidence parity",
    steps: [{ id: "result", kind: "transform", language: "javascript", expression: "return 1;" }],
  });
  const { execution_id } = await suite.seedExecution({
    steps: [{ step_key: "read", kind: "request", status: "succeeded" }],
  });
  const principalId = "77777777-7777-4777-8777-777777777777";
  const checked_at = new Date(0).toISOString();
  await suite.http.db
    .update(executions)
    .set({
      workflow_id: workflow.id,
      execution_mode: "prod",
      caller_origin: "principal",
      caller_context: {
        tenantId: suite.http.tenantId,
        principalId,
        principalKind: "system_account",
        provider: "api_key",
        productId: null,
      },
      authorization_context: {
        source: {
          kind: "api_key",
          api_key_id: "88888888-8888-4888-8888-888888888888",
          credential_version: "private-credential-proof",
        },
        workflow_permission: {
          permission: "workflow:run",
          workflow_id: workflow.id,
          tenant_id: suite.http.tenantId,
          principal_id: principalId,
          principal_kind: "system_account",
          source: "role",
          phase: "admission",
          checked_at,
        },
      },
    })
    .where(and(eq(executions.tenant_id, suite.http.tenantId), eq(executions.id, execution_id)));
  const snapshots = [
    {
      connector_id: uuid(),
      environment: "prod" as const,
      credential_id: null,
      credential_generation: 2,
      connection_id: null,
      access_token_version: null,
      identity: {
        issuer: "https://provider.example.test",
        subject: "provider-account",
        source: "token_endpoint" as const,
      },
    },
  ];
  const request_meta = {
    driver: "http",
    url: "https://provider.example.test/data",
    extras: { effect_kind: "read" },
  };
  await suite.http.db
    .update(executionSteps)
    .set({ credential_snapshots: snapshots, request_meta })
    .where(
      and(
        eq(executionSteps.tenant_id, suite.http.tenantId),
        eq(executionSteps.execution_id, execution_id),
      ),
    );
  await suite.http.db.insert(auditLog).values({
    id: uuid(),
    tenant_id: suite.http.tenantId,
    actor_type: "system",
    actor_id: null,
    action: "execution.started",
    resource_type: "execution",
    resource_id: execution_id,
    result: "success",
    trace_id: "recorded-start-trace",
  });
  const response = await fetch(`${suite.http.baseUrl}/v1/executions/${execution_id}`, {
    headers: { authorization: `Bearer ${suite.http.apiKey}` },
  });
  expect(response.status).toBe(200);
  const viaHttp = (await response.json()) as Record<string, unknown>;
  expect(viaHttp.caller).toMatchObject({ kind: "system_account", principal_id: principalId });
  const client = await suite.connect();
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).toBeFalsy();
    return JSON.parse((result.content as Array<{ text: string }>)[0]?.text ?? "null");
  };
  const detail = await call("get_execution", { id: execution_id });
  const listed = await call("list_executions", { workflow_id: workflow.id });
  const inspected = await call("inspect_execution", { execution_id });
  for (const field of [
    "caller",
    "execution_environment",
    "execution_authority_id",
    "permission_basis",
    "permission_phase",
    "permission_checked_at",
  ]) {
    expect(detail.execution[field]).toEqual(viaHttp[field]);
    expect(listed.items.find((item: { id: string }) => item.id === execution_id)[field]).toEqual(
      viaHttp[field],
    );
    expect(inspected.execution[field]).toEqual(viaHttp[field]);
  }
  expect(detail.execution.trace_id).toBe("recorded-start-trace");
  expect(detail.execution.trace_id).toEqual(viaHttp.trace_id);
  expect(inspected.execution.trace_id).toEqual(viaHttp.trace_id);
  const step = await call("inspect_execution_step", { execution_id, step_key: "read" });
  const stepResponse = await fetch(`${suite.http.baseUrl}/v1/executions/${execution_id}/steps`, {
    headers: { authorization: `Bearer ${suite.http.apiKey}` },
  });
  expect(stepResponse.status).toBe(200);
  const httpSteps = (await stepResponse.json()) as {
    items: Array<{ credential_snapshots: unknown; request_meta: unknown }>;
  };
  expect(step.credential_snapshots).toEqual(snapshots);
  expect(step.credential_snapshots).toEqual(httpSteps.items[0]?.credential_snapshots);
  expect(step.request_meta).toEqual(httpSteps.items[0]?.request_meta);
  expect(inspected.diagnosis.steps[0].credential_snapshots).toEqual(snapshots);
  expect(inspected.diagnosis.steps[0].request_meta.extras.effect_kind).toBe("read");
  expect(JSON.stringify({ detail, listed, inspected, step })).not.toContain(
    "private-credential-proof",
  );
  await suite.http.db
    .update(executions)
    .set({
      input: protectExecutionPayload(
        { private: "payload" },
        suite.http.tenantId,
        execution_id,
        "input",
      ),
    })
    .where(and(eq(executions.tenant_id, suite.http.tenantId), eq(executions.id, execution_id)));
  for (const name of ["inspect_execution", "inspect_execution_step"]) {
    const result = await client.callTool({
      name,
      arguments: {
        execution_id,
        ...(name === "inspect_execution_step" ? { step_key: "read" } : {}),
      },
    });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0]?.text ?? "null");
    expect(data.error_code).toBe("sensitive_execution_unsupported");
    expect(data.credential_snapshots).toBeUndefined();
    expect(data.diagnosis).toBeUndefined();
  }
});
