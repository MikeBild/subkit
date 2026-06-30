// MCP async Tasks surface.
//
// Store-level tests cover derivation details; this suite drives the advertised
// MCP `tasks/*` protocol methods over Streamable HTTP with real auth sessions.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { eq } from "drizzle-orm";
import { conversations, mcpTasks, tenants, users } from "../../db/schema/index.ts";
import { type McpTestSuite, startMcpTestSuite } from "./setup.ts";

let suite: McpTestSuite;

beforeAll(async () => {
  suite = await startMcpTestSuite("tasks-surface");
});

afterAll(async () => {
  await suite.cleanup();
});

async function seedConversation(tenantId = suite.http.tenantId): Promise<string> {
  const [row] = await suite.http.db
    .insert(conversations)
    .values({ tenant_id: tenantId, status: "active", draft: {} })
    .returning({ id: conversations.id });
  if (!row) throw new Error("seed conversation failed");
  return row.id;
}

async function seedTask(
  conversationId: string,
  overrides: Partial<{
    tenantId: string;
    result: Record<string, unknown>;
    failureReason: string;
  }> = {},
): Promise<string> {
  const [row] = await suite.http.db
    .insert(mcpTasks)
    .values({
      tenant_id: overrides.tenantId ?? suite.http.tenantId,
      conversation_id: conversationId,
      turn_seq: 1,
      kind: "start",
      actor_id: null,
      request_source: "mcp",
      user_message_id: null,
      ...(overrides.result ? { result: overrides.result } : {}),
      ...(overrides.failureReason ? { failure_reason: overrides.failureReason } : {}),
    })
    .returning({ id: mcpTasks.id });
  if (!row) throw new Error("seed mcp task failed");
  return row.id;
}

async function seedOtherTenantPrincipal(): Promise<{ apiKey: string; tenantId: string }> {
  const [tenant] = await suite.http.db
    .insert(tenants)
    .values({ slug: "tasks-other", display_name: "Tasks Other" })
    .returning({ id: tenants.id });
  if (!tenant) throw new Error("seed other tenant failed");

  const [user] = await suite.http.db
    .insert(users)
    .values({
      tenant_id: tenant.id,
      email: "tasks-other@test.local",
      role: "admin",
    })
    .returning({ id: users.id });
  if (!user) throw new Error("seed other user failed");

  const { plaintext } = await suite.issueApiKeyForTenant(tenant.id, user.id, ["*"]);
  return { apiKey: plaintext, tenantId: tenant.id };
}

describe("MCP tasks surface", () => {
  test("tasks/list, tasks/get, tasks/result, and tasks/cancel work over MCP", async () => {
    const conversationId = await seedConversation();
    const completedTaskId = await seedTask(conversationId, {
      result: {
        conversation_id: conversationId,
        status: "active",
        events: [{ type: "completed" }],
      },
    });
    const workingTaskId = await seedTask(conversationId);
    const client = await suite.connectTasks();

    const listed = await client.experimental.tasks.listTasks();
    expect(listed.tasks.map((task) => task.taskId)).toContain(completedTaskId);
    expect(listed.tasks.map((task) => task.taskId)).toContain(workingTaskId);

    const completed = await client.experimental.tasks.getTask(completedTaskId);
    expect(completed.taskId).toBe(completedTaskId);
    expect(completed.status).toBe("completed");

    const result = await client.experimental.tasks.getTaskResult(
      completedTaskId,
      CallToolResultSchema,
    );
    expect(result.isError).toBe(false);
    expect(result.content[0]?.type).toBe("text");
    const first = result.content[0];
    const body = JSON.parse(first?.type === "text" ? first.text : "{}") as {
      conversation_id?: string;
      events?: unknown[];
    };
    expect(body.conversation_id).toBe(conversationId);
    expect(Array.isArray(body.events)).toBe(true);

    const working = await client.experimental.tasks.getTask(workingTaskId);
    expect(working.status).toBe("working");
    await client.experimental.tasks.cancelTask(workingTaskId);

    const [cancelledRow] = await suite.http.db
      .select({ cancelled_at: mcpTasks.cancelled_at })
      .from(mcpTasks)
      .where(eq(mcpTasks.id, workingTaskId));
    expect(cancelledRow?.cancelled_at).toBeInstanceOf(Date);

    const cancelled = await client.experimental.tasks.getTask(workingTaskId);
    expect(cancelled.status).toBe("cancelled");
  });

  test("tasks are tenant-isolated across get/result/cancel/list", async () => {
    const conversationId = await seedConversation();
    const taskId = await seedTask(conversationId, {
      result: {
        conversation_id: conversationId,
        status: "active",
        events: [{ type: "completed" }],
      },
    });
    const other = await seedOtherTenantPrincipal();
    const otherClient = await suite.connectTasksWithApiKey(other.apiKey);

    const listed = await otherClient.experimental.tasks.listTasks();
    expect(listed.tasks.map((task) => task.taskId)).not.toContain(taskId);

    await expect(otherClient.experimental.tasks.getTask(taskId)).rejects.toThrow(/not found/i);
    await expect(
      otherClient.experimental.tasks.getTaskResult(taskId, CallToolResultSchema),
    ).rejects.toThrow(/not found/i);
    await expect(otherClient.experimental.tasks.cancelTask(taskId)).rejects.toThrow(/not found/i);
  });
});
