import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { MCP_AUTHORING_SCOPE } from "../../auth/scopes.ts";
import { apiKeys, auditLog, executions, workflows } from "../../db/schema/index.ts";
import { type McpTestSuite, startMcpTestSuite } from "../tests/setup.ts";

let suite: McpTestSuite;

beforeAll(async () => {
  suite = await startMcpTestSuite("workflow-run-refusal");
});

afterAll(async () => {
  await suite.cleanup();
});

function textOf(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  return content[0]?.text ?? "";
}

function bodyOf(result: unknown): Record<string, unknown> {
  return JSON.parse(textOf(result)) as Record<string, unknown>;
}

async function boundaryRefusals(workflow_id: string) {
  return suite.http.db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, suite.http.tenantId),
        eq(auditLog.action, "execution.boundary_refused"),
        eq(auditLog.resource_id, workflow_id),
      ),
    );
}

describe("wf_<slug> admission refusals over MCP", () => {
  test("an archived workflow answers cannot_help and records the refusal", async () => {
    const wf = await suite.seedWorkflow({
      name: "archived probe",
      slug: "archived-probe",
      steps: [{ kind: "transform", id: "t", expression: "return input.input;" }],
    });
    await suite.http.db
      .update(workflows)
      .set({ lifecycle: "archived" })
      .where(and(eq(workflows.tenant_id, suite.http.tenantId), eq(workflows.id, wf.id)));
    const client = await suite.connect();
    const result = await client.callTool({ name: "wf_archived-probe", arguments: {} });
    expect(result.isError).toBe(true);
    const body = bodyOf(result);
    expect(body.status).toBe("cannot_help");
    expect(body.error_code).toBe("workflow_archived");
    expect(body.workflow).toBe("archived-probe");
    const refusals = await boundaryRefusals(wf.id);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.reason).toBe("workflow_archived");
    const metadata = refusals[0]?.metadata as Record<string, unknown>;
    expect(metadata.request_source).toBe("mcp");
    expect(metadata.tool).toBe("wf_archived-probe");
    const rows = await suite.http.db
      .select({ id: executions.id })
      .from(executions)
      .where(and(eq(executions.tenant_id, suite.http.tenantId), eq(executions.workflow_id, wf.id)));
    expect(rows).toHaveLength(0);
  });

  test("an input schema violation answers cannot_help without running", async () => {
    const wf = await suite.seedWorkflow({
      name: "typed probe",
      slug: "typed-probe",
      input_schema: {
        type: "object",
        properties: { count: { type: "integer" } },
        required: ["count"],
      },
      steps: [{ kind: "transform", id: "t", expression: "return input.input;" }],
    });
    const client = await suite.connect();
    const result = await client.callTool({
      name: "wf_typed-probe",
      arguments: { count: "many" },
    });
    expect(result.isError).toBe(true);
    const body = bodyOf(result);
    expect(body.status).toBe("cannot_help");
    expect(body.error_code).toBe("input_schema_violation");
    expect(body.next_best_actions).toEqual(["get_workflow"]);
    const rows = await suite.http.db
      .select({ id: executions.id })
      .from(executions)
      .where(and(eq(executions.tenant_id, suite.http.tenantId), eq(executions.workflow_id, wf.id)));
    expect(rows).toHaveLength(0);
  });
});

describe("wf_<slug> idempotency over MCP", () => {
  test("a repeated idempotency key replays the first execution", async () => {
    const wf = await suite.seedWorkflow({
      name: "keyed probe",
      slug: "keyed-probe",
      steps: [{ kind: "transform", id: "t", expression: "return input.input;" }],
    });
    const client = await suite.connect();
    const first = await client.callTool({
      name: "wf_keyed-probe",
      arguments: { value: 1 },
      _meta: { idempotency_key: "mcp-replay-1" },
    });
    expect(first.isError).not.toBe(true);
    const runs = () =>
      suite.http.db
        .select({ id: executions.id, idempotency_key: executions.idempotency_key })
        .from(executions)
        .where(
          and(eq(executions.tenant_id, suite.http.tenantId), eq(executions.workflow_id, wf.id)),
        );
    const [firstRun] = await runs();
    expect(firstRun?.idempotency_key).toBe("mcp-replay-1");
    const second = await client.callTool({
      name: "wf_keyed-probe",
      arguments: { value: 1 },
      _meta: { idempotency_key: "mcp-replay-1" },
    });
    expect(second.isError).toBe(false);
    const secondBody = bodyOf(second);
    expect(secondBody.idempotent_replay).toBe(true);
    expect(secondBody.status).toBe("succeeded");
    expect(secondBody.execution_id).toBe(firstRun?.id);
    expect(await runs()).toHaveLength(1);
  });

  test("an oversized idempotency key answers cannot_help", async () => {
    await suite.seedWorkflow({
      name: "long key probe",
      slug: "long-key-probe",
      steps: [{ kind: "transform", id: "t", expression: "return input.input;" }],
    });
    const client = await suite.connect();
    const result = await client.callTool({
      name: "wf_long-key-probe",
      arguments: {},
      _meta: { idempotency_key: "k".repeat(201) },
    });
    expect(result.isError).toBe(true);
    const body = bodyOf(result);
    expect(body.status).toBe("cannot_help");
    expect(body.error_code).toBe("bad_request");
  });
});

describe("wf_<slug> authorization over MCP", () => {
  test("an allowlisted key cannot tell a missing workflow from a forbidden one", async () => {
    const allowed = await suite.seedWorkflow({
      name: "allowed probe",
      slug: "allowed-probe",
      steps: [{ kind: "transform", id: "t", expression: "return input.input;" }],
    });
    await suite.seedWorkflow({
      name: "hidden probe",
      slug: "hidden-probe",
      steps: [{ kind: "transform", id: "t", expression: "return input.input;" }],
    });
    const key = await suite.issueApiKey([MCP_AUTHORING_SCOPE]);
    await suite.http.db
      .update(apiKeys)
      .set({ allowed_workflows: [allowed.id] })
      .where(
        and(
          eq(apiKeys.tenant_id, suite.http.tenantId),
          eq(apiKeys.prefix, key.plaintext.slice(0, 12)),
        ),
      );
    const client = await suite.connectWithApiKey(key.plaintext);
    const failure = async (name: string): Promise<string> => {
      try {
        const result = await client.callTool({ name, arguments: {} });
        return `result:${textOf(result)}`;
      } catch (error) {
        return `error:${(error as Error).message}`;
      }
    };
    const forbidden = await failure("wf_hidden-probe");
    const missing = await failure("wf_no-such-probe");
    expect(forbidden).toContain("workflow_not_in_allowlist");
    expect(missing).toBe(forbidden);
    const denials = await suite.http.db
      .select({ reason: auditLog.reason, metadata: auditLog.metadata })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, suite.http.tenantId),
          eq(auditLog.action, "policy.denied"),
          eq(auditLog.resource_id, "no-such-probe"),
        ),
      );
    expect(denials).toHaveLength(1);
    expect(denials[0]?.reason).toBe("workflow_not_in_allowlist");
  });
});
