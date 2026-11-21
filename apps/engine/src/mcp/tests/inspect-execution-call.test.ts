import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { testEnv } from "../../test-helpers/determinism/env.ts";
import { DRAFT_WRITE_MCP_UNAVAILABLE_REASON } from "../../tools/policy.ts";
import { type McpTestSuite, startMcpTestSuite } from "./setup.ts";

let suite: McpTestSuite;

beforeAll(async () => {
  testEnv.SK_MCP_MODE = "authoring";
  suite = await startMcpTestSuite("inspect-execution-call");
});

afterAll(async () => {
  await suite.cleanup();
  delete testEnv.SK_MCP_MODE;
});

describe("mcp inspect_execution — surface-agnostic tenant_read", () => {
  test("tools/list includes inspect_execution without a disabled marker", async () => {
    const client = await suite.connect();
    const result = await client.listTools();
    const tool = result.tools.find((t) => t.name === "inspect_execution");
    expect(tool).toBeDefined();
    const meta = (tool as Record<string, unknown>)._meta as
      | { subkit?: { disabled?: unknown } }
      | undefined;
    expect(meta?.subkit?.disabled).toBeUndefined();
  });

  test("tools/call returns {execution, diagnosis} for an explicit execution_id", async () => {
    const { execution_id } = await suite.seedExecution({
      steps: [
        { step_key: "fetch", kind: "request", status: "succeeded", duration_ms: 21 },
        { step_key: "shape", kind: "transform", status: "succeeded", duration_ms: 4 },
      ],
    });
    const client = await suite.connect();
    const result = await client.callTool({
      name: "inspect_execution",
      arguments: { execution_id },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0]!.text) as {
      execution?: { execution_id?: string; status?: string };
      diagnosis?: { steps?: Array<{ step_key: string }>; reason?: string };
    };
    expect(data.execution?.execution_id).toBe(execution_id);
    expect(data.execution?.status).toBe("succeeded");
    expect(data.diagnosis?.steps?.map((s) => s.step_key)).toEqual(["fetch", "shape"]);
  });

  test("tools/call with no execution_id resolves the latest execution", async () => {
    const { execution_id } = await suite.seedExecution({
      steps: [{ step_key: "latest_step", kind: "request", status: "succeeded" }],
    });
    const client = await suite.connect();
    const result = await client.callTool({ name: "inspect_execution", arguments: {} });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0]!.text) as { execution?: { execution_id?: string } };
    expect(data.execution?.execution_id).toBe(execution_id);
  });

  test("diagnose_latest_execution stays not_available_on_surface on MCP", async () => {
    const client = await suite.connect();
    const result = await client.callTool({
      name: "diagnose_latest_execution",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0]!.text) as { error_code?: string; reason?: string };
    expect(data.error_code).toBe("not_available_on_surface");
    expect(data.reason).toBe(DRAFT_WRITE_MCP_UNAVAILABLE_REASON);
  });
});
