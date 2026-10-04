import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { callConnectorTool } from "../../conversations/tools/call-connector.ts";
import type { ToolContext } from "../../conversations/tools/index.ts";
import { connectors, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { callConnector, callConnectorDriverRefusal } from "./call-connector.ts";

let testDb: TestDb;
let tenant_id: string;
let mcpConnectorId: string;

beforeAll(async () => {
  testDb = await createTestDb("svc_call_connector_mcp_refusal");
  const [t] = await testDb.db
    .insert(tenants)
    .values({ slug: "t-call-mcp", display_name: "T-CALL-MCP" })
    .returning();
  tenant_id = t!.id;
  const [c] = await testDb.db
    .insert(connectors)
    .values({
      tenant_id,
      slug: "remote-mcp",
      display_name: "Remote MCP",
      driver: "mcp",
      environment: "dev",
      auth_type: "none",
      base_url: "https://mcp.example.test/mcp",
      config: { mcp: { transport: "http" } },
    })
    .returning({ id: connectors.id });
  mcpConnectorId = c!.id;
});

afterAll(async () => {
  await testDb.cleanup();
});

describe("the refusal names the shape that fits", () => {
  test("mcp is pointed at the request step's mcp block, not at 'not supported'", () => {
    const refusal = callConnectorDriverRefusal("mcp");
    expect(refusal.message).toContain("mcp");
    expect(refusal.message).toContain("call_tool");
    expect(refusal.message).toContain("connector_id");
    expect(refusal.message).not.toContain("yet");
  });

  test("a driver with no special story still gets the workflow-step handoff", () => {
    expect(callConnectorDriverRefusal("sftp").message).toContain("workflow step");
  });
});

describe("both call_connector surfaces refuse mcp identically", () => {
  test("the REST service returns the shared message", async () => {
    const result = await callConnector({
      db: testDb.db,
      tenant_id,
      actor_id: null,
      connector_id: mcpConnectorId,
      method: "GET",
      path: "/",
    });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.error_code).toBe("driver_not_supported_for_call_connector");
    expect(result.message).toBe(callConnectorDriverRefusal("mcp").message);
  });

  test("the conversation tool returns the same message", async () => {
    const ctx = {
      db: testDb.db,
      tenant_id,
      conversation_id: "00000000-0000-0000-0000-000000000000",
    } as unknown as ToolContext;
    const result = await callConnectorTool.execute(ctx, {
      connector_id: mcpConnectorId,
      method: "GET",
      path: "/",
    });
    expect(result.ok).toBe(false);
    const data = result.data as { error: { code: string; message: string } };
    expect(data.error.code).toBe("driver_not_supported_for_call_connector");
    expect(data.error.message).toBe(callConnectorDriverRefusal("mcp").message);
  });
});
