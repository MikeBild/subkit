// MCP conversation cluster smoke test.
//
// Drives a full list-users conversation via MCP tools/call:
//
//   conversation.start → pauses with pending_approval_id
//   conversation.approve → commits
//   conversation.commit → returns the new workflow id

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connectors } from "../../db/schema/index.ts";
import { resetMockProvider } from "../../llm/mock-provider.ts";
import { type McpTestSuite, startMcpTestSuite } from "../../mcp/tests/setup.ts";

let suite: McpTestSuite;
let connectorId: string;

beforeAll(async () => {
  process.env.LLM_PROVIDER = "mock";
  resetMockProvider();
  suite = await startMcpTestSuite("conversations");
  const [row] = await suite.http.db
    .insert(connectors)
    .values({
      tenant_id: suite.http.tenantId,
      slug: "api-mcp",
      display_name: "API mcp",
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: "https://jsonplaceholder.typicode.com",
      config: {},
    })
    .returning();
  if (!row) throw new Error("seed connector failed");
  connectorId = row.id;
});

afterAll(async () => {
  await suite.cleanup();
});

describe("mcp conversation tools", () => {
  test("start -> approve -> commit drives the full loop", async () => {
    const client = await suite.connect();

    // Both clusters should appear in tools/list.
    const list = await client.listTools();
    const names = list.tools.map((t) => t.name);
    expect(names).toContain("conversation.start");
    expect(names).toContain("conversation.append");
    expect(names).toContain("conversation.approve");
    expect(names).toContain("conversation.reject");
    expect(names).toContain("conversation.commit");

    // Start a conversation via MCP.
    const start = await client.callTool({
      name: "conversation.start",
      arguments: {
        connector_id: connectorId,
        message: "please list users from the api",
      },
    });
    expect(start.isError).toBeFalsy();
    const startContent = (start.content as Array<{ text: string }>)[0]?.text;
    if (!startContent) throw new Error("no start content");
    const startParsed = JSON.parse(startContent) as {
      conversation_id: string;
      status: string;
      pending_approval_id?: string;
    };
    expect(startParsed.status).toBe("awaiting_approval");
    expect(startParsed.pending_approval_id).toBeDefined();

    const approve = await client.callTool({
      name: "conversation.approve",
      arguments: {
        conversation_id: startParsed.conversation_id,
        approval_id: startParsed.pending_approval_id,
      },
    });
    expect(approve.isError).toBeFalsy();
    const approveContent = (approve.content as Array<{ text: string }>)[0]?.text;
    if (!approveContent) throw new Error("no approve content");
    const approveParsed = JSON.parse(approveContent) as {
      status: string;
      committed_workflow_id?: string;
    };
    expect(approveParsed.status).toBe("committed");
    expect(approveParsed.committed_workflow_id).toBeDefined();

    const commit = await client.callTool({
      name: "conversation.commit",
      arguments: { conversation_id: startParsed.conversation_id },
    });
    expect(commit.isError).toBeFalsy();
    const commitContent = (commit.content as Array<{ text: string }>)[0]?.text;
    if (!commitContent) throw new Error("no commit content");
    const commitParsed = JSON.parse(commitContent) as {
      workflow_id: string;
      status: string;
    };
    expect(commitParsed.workflow_id).toBe(approveParsed.committed_workflow_id ?? "");
    expect(commitParsed.status).toBe("committed");
  });
});
