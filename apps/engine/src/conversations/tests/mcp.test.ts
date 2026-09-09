// MCP conversation cluster smoke test — async Tasks (SEP-1686).
//
// Drives a full list-users conversation via MCP tools/call. Each
// turn-driving tool now returns immediately with a `working` status;
// the `conversation.run-turn` worker runs the model loop and the test
// polls `conversation_get` until the turn reaches a terminal state.
//
//   conversation_start            → working → poll → input_required
//   browser approval                → working → poll → completed
//   conversation_commit           → returns the committed workflow id

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { issueBrowserSession } from "../../auth/browser-session.ts";
import { setConfigKey } from "../../config/loader.ts";
import { connectors } from "../../db/schema/index.ts";
import { resetMockProvider } from "../../llm/mock-provider.ts";
import { type McpTestSuite, startMcpTestSuite } from "../../mcp/tests/setup.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";

let suite: McpTestSuite;
let connectorId: string;

beforeAll(async () => {
  process.env.MASTER_KEY = "c".repeat(64);
  process.env.LLM_PROVIDER = "mock";
  // The mode-split MCP catalog hides conversation.* by default; this
  // suite tests the authoring cluster specifically, so opt into
  // authoring mode explicitly for the duration of the run.
  process.env.SK_MCP_MODE = "authoring";
  resetMockProvider();
  // withQueue — the conversation tools enqueue a background turn.
  suite = await startMcpTestSuite("conversations", { withQueue: true });
  await setConfigKey("server.public_base_url", suite.http.baseUrl, { force: true });
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
  input?: { approval_url?: string };
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
  test("start -> browser approval -> commit drives the full loop", async () => {
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
      _meta: { sk_permission_mode: "ask" },
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
    expect(settled.input?.approval_url).toContain("/v1/tool-approvals/decide");

    // A model-facing tool must not relay the human decision. The browser
    // portal owns approval and enqueues the background resume turn.
    const approvalUrl = settled.input?.approval_url ?? "";
    const login = await issueBrowserSession({
      db: suite.http.db,
      tenantId: suite.http.tenantId,
      userId: suite.http.userId,
      redirectTo: approvalUrl,
      via: "mcp_conversation_browser_test",
    });
    const headers = { cookie: login.headers.get("set-cookie") ?? "" };
    expect(headers.cookie).not.toBe("");
    const page = await fetch(approvalUrl, { headers });
    expect(page.status).toBe(200);
    const html = await page.text();
    const csrfToken = /name="csrf_token" value="([^"]+)"/.exec(html)?.[1] ?? "";
    const grant = new URL(approvalUrl).searchParams.get("grant") ?? "";
    const approval = await fetch(`${suite.http.baseUrl}/v1/tool-approvals/decide`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant,
        decision: "approve",
        csrf_token: csrfToken,
      }).toString(),
    });
    expect(approval.status).toBe(200);

    // Poll — the portal-created resume turn commits the workflow. Waiting
    // specifically for `completed` avoids treating the previous pause as a
    // fresh terminal result before the queue worker has claimed the task.
    let committedPoll: GetResult | null = null;
    await waitFor(
      async () => {
        const got = await client.callTool({
          name: "conversation_get",
          arguments: { conversation_id: startParsed.conversation_id },
        });
        expect(got.isError).toBeFalsy();
        const text = (got.content as Array<{ text: string }>)[0]?.text;
        if (!text) throw new Error("conversation_get returned no content");
        const parsed = JSON.parse(text) as GetResult;
        if (parsed.status !== "completed") return false;
        committedPoll = parsed;
        return true;
      },
      { tries: 80, sleepMs: 250, label: "conversation_get completed after browser approval" },
    );
    if (!committedPoll) throw new Error("conversation_get never completed");

    // conversation_commit reports the committed workflow id.
    const commit = await client.callTool({
      name: "conversation_commit",
      arguments: { conversation_id: startParsed.conversation_id },
    });
    expect(commit.isError).toBeFalsy();
    const commitParsed = JSON.parse(
      (commit.content as Array<{ text: string }>)[0]?.text ?? "{}",
    ) as {
      workflow_id: string;
      status: string;
      committed?: { version: number; steps_present: number };
      draft_state?: string;
      persistence_kind: string;
      activation_required: boolean;
      current_version_id: string | null;
      usage?: unknown;
    };
    expect(commitParsed.workflow_id.length).toBeGreaterThan(0);
    expect(commitParsed.status).toBe("active");
    expect(commitParsed.persistence_kind).toBe("draft");
    expect(commitParsed.activation_required).toBe(true);
    expect(commitParsed.current_version_id).toBeNull();
    expect(commitParsed.usage).toBeUndefined();
    // The reply carries persisted facts, not a draft echo.
    expect(commitParsed.committed?.version).toBeGreaterThanOrEqual(1);
    expect(commitParsed.committed?.steps_present).toBeGreaterThanOrEqual(1);
    expect(commitParsed.draft_state).toBeDefined();
  }, 60_000);
});
