import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { issueBrowserSession } from "../../auth/browser-session.ts";
import { setConfigKey } from "../../config/loader.ts";
import { connectors } from "../../db/schema/index.ts";
import { resetMockProvider } from "../../llm/mock-provider.ts";
import { type McpTestSuite, startMcpTestSuite } from "../../mcp/tests/setup.ts";
import { testEnv } from "../../test-helpers/determinism/env.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";

let suite: McpTestSuite;
let connectorId: string;

beforeAll(async () => {
  testEnv.MASTER_KEY = "c".repeat(64);
  testEnv.LLM_PROVIDER = "mock";
  testEnv.SK_MCP_MODE = "authoring";
  resetMockProvider();
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
  delete testEnv.SK_MCP_MODE;
});

interface GetResult {
  status: string;
  conversation_id: string;
  events?: unknown[];
  pending_elicitation_id?: string;
  committed_workflow_id?: string;
  input?: { approval_url?: string };
}

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

    const settled = await pollUntilSettled(client, startParsed.conversation_id);
    expect(settled.status).toBe("input_required");
    expect(settled.pending_elicitation_id).toBeDefined();
    expect(settled.input?.approval_url).toContain("/v1/tool-approvals/decide");

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
    expect(commitParsed.committed?.version).toBeGreaterThanOrEqual(1);
    expect(commitParsed.committed?.steps_present).toBeGreaterThanOrEqual(1);
    expect(commitParsed.draft_state).toBeDefined();
  }, 60_000);
});
