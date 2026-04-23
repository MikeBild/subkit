// MCP conversation cluster smoke test.
//
// Drives a full list-users conversation via MCP tools/call:
//
//   conversation.start            → pauses with pending_elicitation_id
//   conversation.respond_elicitation → approves the pending askUser.confirm
//   conversation.commit           → returns the committed workflow id

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connectors } from "../../db/schema/index.ts";
import { resetMockProvider } from "../../llm/mock-provider.ts";
import { type McpTestSuite, startMcpTestSuite } from "../../mcp/tests/setup.ts";

let suite: McpTestSuite;
let connectorId: string;

beforeAll(async () => {
  process.env.LLM_PROVIDER = "mock";
  // The mode-split MCP catalog hides conversation.* by default; this
  // suite tests the authoring cluster specifically, so opt into
  // authoring mode explicitly for the duration of the run.
  process.env.SK_MCP_MODE = "authoring";
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
  delete process.env.SK_MCP_MODE;
});

describe("mcp conversation tools", () => {
  test("start -> respond_elicitation -> commit drives the full loop", async () => {
    const client = await suite.connect();

    // The canonical cluster: start + append + respond_elicitation + commit.
    const list = await client.listTools();
    const names = list.tools.map((t) => t.name);
    expect(names).toContain("conversation.start");
    expect(names).toContain("conversation.append");
    expect(names).toContain("conversation.respond_elicitation");
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
      pending_elicitation_id?: string;
    };
    expect(startParsed.status).toBe("awaiting_input");
    expect(startParsed.pending_elicitation_id).toBeDefined();

    const respond = await client.callTool({
      name: "conversation.respond_elicitation",
      arguments: {
        conversation_id: startParsed.conversation_id,
        elicitation_id: startParsed.pending_elicitation_id,
        output: { confirmed: true },
      },
    });
    expect(respond.isError).toBeFalsy();
    const respondContent = (respond.content as Array<{ text: string }>)[0]?.text;
    if (!respondContent) throw new Error("no respond content");
    const respondParsed = JSON.parse(respondContent) as {
      status: string;
      events?: unknown[];
    };
    expect(respondParsed.status).toBe("committed");

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
    expect(commitParsed.workflow_id.length).toBeGreaterThan(0);
    expect(commitParsed.status).toBe("committed");
  });
});
