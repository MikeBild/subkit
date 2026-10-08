import { afterAll, beforeAll, expect, test } from "bun:test";
import { auditLog, executions } from "../../db/schema/index.ts";
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
  const viaHttp = (await res.json()) as { caller: unknown };

  const client = await suite.connect();
  const result = await client.callTool({ name: "get_execution", arguments: { id: executionId } });
  const content = result.content as Array<{ type: string; text: string }>;
  const viaMcp = JSON.parse(content[0]?.text ?? "null") as { execution: { caller: unknown } };

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
