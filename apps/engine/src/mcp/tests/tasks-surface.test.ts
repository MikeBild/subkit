import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { eq } from "drizzle-orm";
import { mcpTasks, users } from "../../db/schema/index.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { seedConversation as seedConversationRow, seedTenant } from "../../test-helpers/seed.ts";
import { type McpTestSuite, startMcpTestSuite } from "./setup.ts";

let suite: McpTestSuite;

beforeAll(async () => {
  suite = await startMcpTestSuite("tasks-surface");
});

afterAll(async () => {
  await suite.cleanup();
});

async function seedConversation(tenantId = suite.http.tenantId): Promise<string> {
  const row = await seedConversationRow(suite.http.db, {
    tenant_id: tenantId,
    status: "active",
    draft: {},
  });
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
  const tenant = await seedTenant(suite.http.db, {
    slug: "tasks-other",
    display_name: "Tasks Other",
  });

  const [user] = await suite.http.db
    .insert(users)
    .values({
      tenant_id: tenant.id,
      email: "tasks-other@test.local",
      role_id: await builtinRoleId(suite.http.db, "admin"),
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

  test("A4: tasks/result for a completed task carries _meta related-task taskId", async () => {
    const conversationId = await seedConversation();
    const taskId = await seedTask(conversationId, {
      result: {
        conversation_id: conversationId,
        status: "active",
        events: [{ type: "completed" }],
      },
    });
    const client = await suite.connectTasks();

    const result = await client.experimental.tasks.getTaskResult(taskId, CallToolResultSchema);
    expect(result.isError).toBe(false);

    const meta = (result as { _meta?: Record<string, unknown> })._meta;
    const relatedTask = meta?.["io.modelcontextprotocol/related-task"] as
      | { taskId?: string }
      | undefined;
    expect(relatedTask?.taskId).toBe(taskId);
  });

  test("A4: tasks/result for a failed task carries _meta related-task taskId", async () => {
    const conversationId = await seedConversation();
    const taskId = await seedTask(conversationId, {
      failureReason: "simulated_worker_failure",
    });
    const client = await suite.connectTasks();

    const result = await client.experimental.tasks.getTaskResult(taskId, CallToolResultSchema);
    expect(result.isError).toBe(true);

    const meta = (result as { _meta?: Record<string, unknown> })._meta;
    const relatedTask = meta?.["io.modelcontextprotocol/related-task"] as
      | { taskId?: string }
      | undefined;
    expect(relatedTask?.taskId).toBe(taskId);
  });

  test("P2: task with failure_reason derives status=failed with the failure reason as statusMessage", async () => {
    const conversationId = await seedConversation();
    const failureMsg = "connector_timeout_simulated";
    const taskId = await seedTask(conversationId, { failureReason: failureMsg });
    const client = await suite.connectTasks();

    const task = await client.experimental.tasks.getTask(taskId);
    expect(task.status).toBe("failed");
    expect(task.statusMessage).toBe(failureMsg);
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
