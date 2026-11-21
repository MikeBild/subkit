import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { MCP_AUTHORING_SCOPE } from "../../auth/scopes.ts";
import { mcpTasks } from "../../db/schema/index.ts";
import { resetMockProvider } from "../../llm/mock-provider.ts";
import { testEnv } from "../../test-helpers/determinism/env.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import { type McpTestSuite, startMcpTestSuite } from "./setup.ts";

let suite: McpTestSuite;

beforeAll(async () => {
  testEnv.LLM_PROVIDER = "mock";
  resetMockProvider();
  suite = await startMcpTestSuite("conversation-system-account-actor", { withQueue: true });
}, 90_000);

afterAll(async () => {
  await suite?.cleanup();
}, 30_000);

function envelope(result: unknown): Record<string, unknown> {
  const r = result as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
  expect(r.isError ?? false).toBe(false);
  const item = r.content?.[0];
  return JSON.parse(item?.type === "text" ? (item.text ?? "{}") : "{}") as Record<string, unknown>;
}

async function waitForTerminal(taskId: string): Promise<void> {
  await waitFor(
    async () => {
      const [row] = await suite.http.db
        .select({
          result: mcpTasks.result,
          failure_reason: mcpTasks.failure_reason,
          cancelled_at: mcpTasks.cancelled_at,
        })
        .from(mcpTasks)
        .where(and(eq(mcpTasks.tenant_id, suite.http.tenantId), eq(mcpTasks.id, taskId)));
      return Boolean(row && (row.result || row.failure_reason || row.cancelled_at));
    },
    { tries: 240, sleepMs: 250, label: "mcp_task terminal state" },
  );
}

describe("conversation_start over /mcp with a system-account credential", () => {
  test("the mcp_tasks row names the system account as its actor", async () => {
    const { plaintext, system_account_id } = await suite.issueSystemAccountApiKey([
      MCP_AUTHORING_SCOPE,
    ]);
    const client = await suite.connectWithApiKey(plaintext);
    try {
      const started = envelope(
        await client.callTool({
          name: "conversation_start",
          arguments: { message: "hello from a bot" },
        }),
      );
      const taskId = started.mcp_task_id;
      expect(typeof taskId).toBe("string");
      if (typeof taskId !== "string") throw new Error("mcp_task_id missing");

      const [task] = await suite.http.db
        .select({
          actor_id: mcpTasks.actor_id,
          actor_kind: mcpTasks.actor_kind,
          kind: mcpTasks.kind,
        })
        .from(mcpTasks)
        .where(and(eq(mcpTasks.tenant_id, suite.http.tenantId), eq(mcpTasks.id, taskId)));
      expect(task).toEqual({
        actor_id: system_account_id,
        actor_kind: "system_account",
        kind: "start",
      });
      await waitForTerminal(taskId);
    } finally {
      await client.close();
    }
  }, 120_000);

  test("a human credential on the same route is recorded as a user", async () => {
    const client = await suite.connect();
    try {
      const started = envelope(
        await client.callTool({
          name: "conversation_start",
          arguments: { message: "hello from a person" },
        }),
      );
      const taskId = started.mcp_task_id;
      if (typeof taskId !== "string") throw new Error("mcp_task_id missing");
      const [task] = await suite.http.db
        .select({ actor_id: mcpTasks.actor_id, actor_kind: mcpTasks.actor_kind })
        .from(mcpTasks)
        .where(and(eq(mcpTasks.tenant_id, suite.http.tenantId), eq(mcpTasks.id, taskId)));
      expect(task).toEqual({ actor_id: suite.http.userId, actor_kind: "user" });
      await waitForTerminal(taskId);
    } finally {
      await client.close();
    }
  }, 120_000);
});
