// MCP async Tasks (SEP-1686) — the Tasks-capable client path.
//
// `mcp.test.ts` covers the non-Tasks path (plain `working` body +
// `conversation_get` poll). This suite drives the OTHER path: a client
// that advertises the `tasks` capability. The conversation tool returns
// a `CreateTaskResult` and the client polls `tasks/get` + `tasks/result`
// through the SDK's experimental task surface.
//
//   conversation_start (task-augmented) → taskCreated(working)
//     → tasks/get poll → completed | input_required
//     → tasks/result → the terminal CallToolResult envelope
//
// Also pins `tasks/list` and `tasks/cancel` of an already-terminal task.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Task } from "@modelcontextprotocol/sdk/types.js";
import { CallToolResultSchema, CreateTaskResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { connectors } from "../../db/schema/index.ts";
import { resetMockProvider } from "../../llm/mock-provider.ts";
import { getMcpTask } from "../../mcp/tasks/store.ts";
import { type McpTestSuite, startMcpTestSuite } from "../../mcp/tests/setup.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";

let suite: McpTestSuite;
let connectorId: string;

beforeAll(async () => {
  process.env.LLM_PROVIDER = "mock";
  process.env.SK_MCP_MODE = "authoring";
  resetMockProvider();
  suite = await startMcpTestSuite("conversations-tasks", { withQueue: true });
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
  delete process.env.SK_MCP_MODE;
});

/** Poll `tasks/get` through the experimental client until terminal. */
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
  /** Issue a task-augmented `tools/call` and return the created task id. */
  async function callToolAsTask(
    client: Awaited<ReturnType<McpTestSuite["connectTasks"]>>,
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const createResult = (await client.request(
      { method: "tools/call", params: { name, arguments: args, task: {} } },
      CreateTaskResultSchema,
    )) as { task: { taskId: string; status: string } };
    expect(createResult.task.taskId.length).toBeGreaterThan(0);
    // The conversation handler short-circuits with a `working` task.
    expect(createResult.task.status).toBe("working");
    return createResult.task.taskId;
  }

  test("full Tasks path: start → input_required → respond_elicitation → completed → tasks/result", async () => {
    const client = await suite.connectTasks();

    // 1) Task-augmented `conversation_start`: the SDK adds `params.task`
    // because this client advertised the `tasks` capability; the
    // conversation handler returns a `CreateTaskResult`.
    const startTaskId = await callToolAsTask(client, "conversation_start", {
      connector_id: connectorId,
      message: "please list users from the api",
    });

    // 2) Poll `tasks/get`. The backgrounded turn passes NO live
    // elicitation bridge → the ask_user_confirm takes the DB-pause path,
    // so the task derives `input_required`, not `completed`.
    const startSettled = await pollTask(client, startTaskId);
    expect(startSettled.status).toBe("input_required");

    // The `mcp_tasks` index row correlates the taskId to its
    // conversation; `conversation_get` then carries the pending
    // elicitation form (which Tasks `tasks/get` intentionally omits).
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
    };
    expect(getBody.status).toBe("input_required");
    expect(getBody.pending_elicitation_id).toBeDefined();

    // 3) Task-augmented `conversation_respond_elicitation` — spawns a
    // fresh background turn that resumes the loop and commits.
    const respondTaskId = await callToolAsTask(client, "conversation_respond_elicitation", {
      conversation_id: conversationId,
      elicitation_id: getBody.pending_elicitation_id,
      output: { confirmed: true },
    });

    // 4) Poll the resume task to a terminal state. The resumed turn
    // commits the workflow → the task derives `completed`.
    const respondSettled = await pollTask(client, respondTaskId);
    expect(respondSettled.status).toBe("completed");

    // 5) `tasks/result` returns the terminal CallToolResult envelope —
    // the same body a non-Tasks client reads via `conversation_get`.
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
    // The previous test created at least one task for this tenant.
    expect(tasks.length).toBeGreaterThan(0);
    for (const t of tasks) {
      expect(["working", "input_required", "completed", "failed", "cancelled"]).toContain(t.status);
    }
  }, 30_000);

  test("tasks/cancel of an already-terminal task is accepted (idempotent)", async () => {
    const client = await suite.connectTasks();

    const createResult = (await client.request(
      {
        method: "tools/call",
        params: {
          name: "conversation_start",
          arguments: { connector_id: connectorId, message: "list users from the api" },
          task: {},
        },
      },
      CreateTaskResultSchema,
    )) as { task: { taskId: string } };
    const taskId = createResult.task.taskId;
    expect(taskId.length).toBeGreaterThan(0);

    // Let the turn settle, then cancel — the task is already terminal.
    await pollTask(client, taskId);
    await client.experimental.tasks.cancelTask(taskId);

    // After a cancel, derivation puts `cancelled` above `completed`.
    const afterCancel = await client.experimental.tasks.getTask(taskId);
    expect(afterCancel.status).toBe("cancelled");
  }, 60_000);
});
