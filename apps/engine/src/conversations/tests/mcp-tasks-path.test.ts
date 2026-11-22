import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Task } from "@modelcontextprotocol/sdk/types.js";
import { CallToolResultSchema, CreateTaskResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { and, eq } from "drizzle-orm";
import { issueBrowserSession } from "../../auth/browser-session.ts";
import { setConfigKey } from "../../config/loader.ts";
import { connectors, mcpTasks } from "../../db/schema/index.ts";
import { resetMockProvider } from "../../llm/mock-provider.ts";
import { getMcpTask } from "../../mcp/tasks/store.ts";
import { type McpTestSuite, startMcpTestSuite } from "../../mcp/tests/setup.ts";
import { testEnv } from "../../test-helpers/determinism/env.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";

let suite: McpTestSuite;
let connectorId: string;

beforeAll(async () => {
  testEnv.MASTER_KEY = "b".repeat(64);
  testEnv.LLM_PROVIDER = "mock";
  testEnv.SUBKIT_MCP_MODE = "authoring";
  resetMockProvider();
  suite = await startMcpTestSuite("conversations-tasks", { withQueue: true });
  await setConfigKey("server.public_base_url", suite.http.baseUrl, { force: true });
  const [row] = await suite.http.db
    .insert(connectors)
    .values({
      tenant_id: suite.http.tenantId,
      slug: "api-mcp-tasks",
      display_name: "API mcp tasks",
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
  delete testEnv.SUBKIT_MCP_MODE;
});

async function pollTask(
  client: Awaited<ReturnType<McpTestSuite["connectTasks"]>>,
  taskId: string,
): Promise<Task> {
  let settled: Task | null = null;
  await waitFor(
    async () => {
      const task = await client.experimental.tasks.getTask(taskId);
      if (task.status === "working") return false;
      settled = task;
      return true;
    },
    { tries: 80, sleepMs: 250, label: "tasks/get settled" },
  );
  if (!settled) throw new Error("task never settled");
  return settled;
}

describe("mcp async Tasks — Tasks-capable client path", () => {
  async function callToolAsTask(
    client: Awaited<ReturnType<McpTestSuite["connectTasks"]>>,
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const createResult = (await client.request(
      {
        method: "tools/call",
        params: {
          name,
          arguments: args,
          task: {},
        },
      },
      CreateTaskResultSchema,
    )) as { task: { taskId: string; status: string } };
    expect(createResult.task.taskId.length).toBeGreaterThan(0);
    expect(createResult.task.status).toBe("working");
    return createResult.task.taskId;
  }

  async function decideApproval(approvalUrl: string, decision: "approve" | "decline") {
    const login = await issueBrowserSession({
      db: suite.http.db,
      tenantId: suite.http.tenantId,
      userId: suite.http.userId,
      redirectTo: approvalUrl,
      via: "mcp_tasks_browser_test",
    });
    const headers = { cookie: login.headers.get("set-cookie") ?? "" };
    expect(headers.cookie).not.toBe("");
    const page = await fetch(approvalUrl, { headers });
    const html = await page.text();
    const csrfToken = /name="csrf_token" value="([^"]+)"/.exec(html)?.[1] ?? "";
    const grant = new URL(approvalUrl).searchParams.get("grant") ?? "";
    return await fetch(`${suite.http.baseUrl}/v1/tool-approvals/decide`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant, decision, csrf_token: csrfToken }).toString(),
    });
  }

  test("full Tasks path: start → input_required → browser approval → completed → tasks/result", async () => {
    const client = await suite.connectTasks();

    const startTaskId = await callToolAsTask(client, "conversation_start", {
      connector_id: connectorId,
      message: "please list users from the api",
    });

    const startSettled = await pollTask(client, startTaskId);
    expect(startSettled.status).toBe("input_required");

    const startRow = await getMcpTask(suite.http.tenantId, startTaskId, suite.http.db);
    if (!startRow) throw new Error("start task row missing");
    const conversationId = startRow.conversation_id;
    const getRaw = await client.callTool({
      name: "conversation_get",
      arguments: { conversation_id: conversationId },
    });
    const getBody = JSON.parse((getRaw.content as Array<{ text: string }>)[0]?.text ?? "{}") as {
      status: string;
      pending_elicitation_id?: string;
      conversation_id: string;
      input?: { approval_url?: string };
    };
    expect(getBody.status).toBe("input_required");
    expect(getBody.pending_elicitation_id).toBeDefined();
    expect(getBody.input?.approval_url).toContain("/v1/tool-approvals/decide");

    const approval = await decideApproval(getBody.input?.approval_url ?? "", "approve");
    expect(approval.status).toBe(200);
    let respondTaskId = "";
    await waitFor(
      async () => {
        const [row] = await suite.http.db
          .select({ id: mcpTasks.id })
          .from(mcpTasks)
          .where(
            and(
              eq(mcpTasks.tenant_id, suite.http.tenantId),
              eq(mcpTasks.conversation_id, conversationId),
              eq(mcpTasks.kind, "respond_elicitation"),
            ),
          )
          .limit(1);
        respondTaskId = row?.id ?? "";
        return respondTaskId.length > 0;
      },
      { tries: 40, sleepMs: 100, label: "portal-created response task" },
    );

    const respondSettled = await pollTask(client, respondTaskId);
    expect(respondSettled.status).toBe("completed");

    const result = (await client.experimental.tasks.getTaskResult(
      respondTaskId,
      CallToolResultSchema,
    )) as { content: Array<{ type: string; text: string }>; isError: boolean };
    expect(result.isError).toBe(false);
    const envelope = JSON.parse(result.content[0]?.text ?? "{}") as {
      conversation_id: string;
      status: string;
      events: unknown[];
    };
    expect(envelope.conversation_id).toBe(conversationId);
    expect(Array.isArray(envelope.events)).toBe(true);
  }, 90_000);

  test("tasks/list returns the calling tenant's tasks", async () => {
    const client = await suite.connectTasks();
    const { tasks } = await client.experimental.tasks.listTasks();
    expect(tasks.length).toBeGreaterThan(0);
    for (const t of tasks) {
      expect(["working", "input_required", "completed", "failed", "cancelled"]).toContain(t.status);
    }
  }, 30_000);

  test("tasks/cancel of an input-required task is accepted", async () => {
    const client = await suite.connectTasks();
    const [cancelConnector] = await suite.http.db
      .insert(connectors)
      .values({
        tenant_id: suite.http.tenantId,
        slug: "api-mcp-tasks-cancel",
        display_name: "API cancellation fixture",
        driver: "http",
        environment: "dev",
        auth_type: "none",
        base_url: "https://jsonplaceholder.typicode.com",
        config: {},
      })
      .returning();
    if (!cancelConnector) throw new Error("seed cancellation connector failed");

    const createResult = (await client.request(
      {
        method: "tools/call",
        params: {
          name: "conversation_start",
          arguments: { connector_id: cancelConnector.id, message: "list users from the api" },
          task: {},
        },
      },
      CreateTaskResultSchema,
    )) as { task: { taskId: string } };
    const taskId = createResult.task.taskId;
    expect(taskId.length).toBeGreaterThan(0);

    const waiting = await pollTask(client, taskId);
    expect(waiting.status).toBe("input_required");
    await client.experimental.tasks.cancelTask(taskId);

    const afterCancel = await client.experimental.tasks.getTask(taskId);
    expect(afterCancel.status).toBe("cancelled");
  }, 60_000);
});
