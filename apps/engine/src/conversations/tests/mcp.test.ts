// MCP conversation cluster smoke test — async Tasks (SEP-1686).
//
// Drives a full list-users conversation via MCP tools/call. Each
// turn-driving tool now returns immediately with a `working` status;
// the `conversation.run-turn` worker runs the model loop and the test
// polls `conversation_get` until the turn reaches a terminal state.
//
//   conversation_start            → working → poll → input_required
//   conversation_respond_elicitation → working → poll → completed
//   conversation_commit           → returns the committed workflow id

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connectors } from "../../db/schema/index.ts";
import { resetMockProvider } from "../../llm/mock-provider.ts";
import { type McpTestSuite, startMcpTestSuite } from "../../mcp/tests/setup.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";

let suite: McpTestSuite;
let connectorId: string;

beforeAll(async () => {
  process.env.LLM_PROVIDER = "mock";
  // The mode-split MCP catalog hides conversation.* by default; this
  // suite tests the authoring cluster specifically, so opt into
  // authoring mode explicitly for the duration of the run.
  process.env.SK_MCP_MODE = "authoring";
  resetMockProvider();
  // withQueue — the conversation tools enqueue a background turn.
  suite = await startMcpTestSuite("conversations", { withQueue: true });
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

interface GetResult {
  status: string;
  conversation_id: string;
  events?: unknown[];
  pending_elicitation_id?: string;
  committed_workflow_id?: string;
}

/** Poll `conversation_get` until the turn leaves `working`. */
async function pollUntilSettled(
  client: Awaited<ReturnType<McpTestSuite["connect"]>>,
  conversation_id: string,
): Promise<GetResult> {
  let settled: GetResult | null = null;
  await waitFor(
    async () => {
      const got = await client.callTool({
        name: "conversation_get",
        arguments: { conversation_id },
      });
      expect(got.isError).toBeFalsy();
      const text = (got.content as Array<{ text: string }>)[0]?.text;
      if (!text) throw new Error("conversation_get returned no content");
      const parsed = JSON.parse(text) as GetResult;
      if (parsed.status === "working") return false;
      settled = parsed;
      return true;
    },
    { tries: 80, sleepMs: 250, label: "conversation_get settled" },
  );
  if (!settled) throw new Error("conversation_get never settled");
  return settled;
}

describe("mcp conversation tools", () => {
  test("start -> respond_elicitation -> commit drives the full loop", async () => {
    const client = await suite.connect();

    const list = await client.listTools();
    const names = list.tools.map((t) => t.name);
    expect(names).toContain("conversation_start");
    expect(names).toContain("conversation_append");
    expect(names).toContain("conversation_respond_elicitation");
    expect(names).toContain("conversation_get");
    expect(names).toContain("conversation_commit");

    // Start — returns fast `working` with the conversation id to poll.
    const start = await client.callTool({
      name: "conversation_start",
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
      mcp_task_id: string;
      status: string;
      poll_with: string;
    };
    expect(startParsed.status).toBe("working");
    expect(startParsed.poll_with).toBe("conversation_get");
    expect(startParsed.mcp_task_id.length).toBeGreaterThan(0);

    // Poll — the turn pauses at the ask_user_confirm elicitation.
    const settled = await pollUntilSettled(client, startParsed.conversation_id);
    expect(settled.status).toBe("input_required");
    expect(settled.pending_elicitation_id).toBeDefined();

    // Respond — enqueues another background turn.
    const respond = await client.callTool({
      name: "conversation_respond_elicitation",
      arguments: {
        conversation_id: startParsed.conversation_id,
        elicitation_id: settled.pending_elicitation_id,
        output: { confirmed: true },
      },
    });
    expect(respond.isError).toBeFalsy();
    const respondParsed = JSON.parse(
      (respond.content as Array<{ text: string }>)[0]?.text ?? "{}",
    ) as { status: string };
    expect(respondParsed.status).toBe("working");

    // Poll — the resumed turn commits the workflow.
    const committedPoll = await pollUntilSettled(client, startParsed.conversation_id);
    expect(committedPoll.status).toBe("completed");

    // conversation_commit reports the committed workflow id.
    const commit = await client.callTool({
      name: "conversation_commit",
      arguments: { conversation_id: startParsed.conversation_id },
    });
    expect(commit.isError).toBeFalsy();
    const commitParsed = JSON.parse(
      (commit.content as Array<{ text: string }>)[0]?.text ?? "{}",
    ) as { workflow_id: string; status: string };
    expect(commitParsed.workflow_id.length).toBeGreaterThan(0);
    expect(commitParsed.status).toBe("committed");
  }, 60_000);
});
