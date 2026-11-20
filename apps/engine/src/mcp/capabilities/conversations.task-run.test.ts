import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { createElicitation } from "../../conversations/elicitations.ts";
import { createConversation } from "../../conversations/service.ts";
import {
  conversationElicitations,
  conversationMessages,
  conversationTurns,
  mcpTasks,
} from "../../db/schema/index.ts";
import { ConversationTaskStore } from "../tasks/task-store.ts";
import { handleConversationTool } from "./conversations.ts";
import {
  principal,
  setupConversationCapabilities,
  testDb,
} from "./tests/conversations-fixtures.ts";

setupConversationCapabilities();

const OWNER = "7a7a7a7a-1111-4222-8333-444444444444";
const MARKER = {
  task_id: "44444444-5555-4666-8777-888888888888",
  task_run_id: "55555555-6666-4777-8888-999999999999",
  environment: "dev" as const,
  workflow_ids: [],
  connector_ids: [],
  web_search: false,
};

async function runConversation(): Promise<string> {
  const created = await createConversation(
    { tenant_id: principal.tenant_id, actor_id: OWNER, task_run: MARKER },
    testDb.db,
  );
  return created.conversation.id;
}

async function traces(conversation_id: string) {
  const [messages, turns, tasks] = await Promise.all([
    testDb.db
      .select({ id: conversationMessages.id })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.tenant_id, principal.tenant_id),
          eq(conversationMessages.conversation_id, conversation_id),
        ),
      ),
    testDb.db
      .select({ id: conversationTurns.id })
      .from(conversationTurns)
      .where(
        and(
          eq(conversationTurns.tenant_id, principal.tenant_id),
          eq(conversationTurns.conversation_id, conversation_id),
        ),
      ),
    testDb.db
      .select({ id: mcpTasks.id })
      .from(mcpTasks)
      .where(
        and(
          eq(mcpTasks.tenant_id, principal.tenant_id),
          eq(mcpTasks.conversation_id, conversation_id),
        ),
      ),
  ]);
  return { messages: messages.length, turns: turns.length, tasks: tasks.length };
}

describe("MCP writes to a task run conversation", () => {
  const stranger = { ...principal, roles: ["member"] };

  test("a caller who is neither owner nor admin cannot append; nothing is reserved or stored", async () => {
    const conversation_id = await runConversation();
    const outcome = await handleConversationTool({
      db: testDb.db,
      principal: stranger,
      name: "conversation_append",
      args: { conversation_id, message: "do something else" },
    }).then(
      (result) => ({ refused: result.isError === true }),
      () => ({ refused: true }),
    );
    expect(outcome.refused).toBe(true);
    expect(await traces(conversation_id)).toEqual({ messages: 0, turns: 0, tasks: 0 });
  });

  test("a foreign answer is not staged", async () => {
    const conversation_id = await runConversation();
    const pending = await createElicitation(
      {
        tenant_id: principal.tenant_id,
        conversation_id,
        tool_call_id: null,
        parent_message_id: null,
        tool_name: "ask_user_text",
        summary: "Which month?",
        input: { question: "Which month?" },
        actor_id: OWNER,
        actor_type: "user",
      },
      testDb.db,
    );
    const outcome = await handleConversationTool({
      db: testDb.db,
      principal: stranger,
      name: "conversation_respond_elicitation",
      args: { conversation_id, elicitation_id: pending.id, output: { text: "March" } },
    }).then(
      (result) => ({ refused: result.isError === true }),
      () => ({ refused: true }),
    );
    expect(outcome.refused).toBe(true);
    const [row] = await testDb.db
      .select()
      .from(conversationElicitations)
      .where(
        and(
          eq(conversationElicitations.tenant_id, principal.tenant_id),
          eq(conversationElicitations.id, pending.id),
        ),
      );
    expect(row?.status).toBe("pending");
    expect(JSON.stringify(row)).not.toContain("March");
    expect((await traces(conversation_id)).turns).toBe(0);
  });

  test("yolo is rejected before anything is reserved", async () => {
    const conversation_id = await runConversation();
    const admin = { ...principal, roles: ["admin"] };
    const outcome = await handleConversationTool({
      db: testDb.db,
      principal: admin,
      name: "conversation_append",
      args: { conversation_id, message: "just do it" },
      permission_mode: "yolo",
    }).then(
      (result) => ({ refused: result.isError === true }),
      () => ({ refused: true }),
    );
    expect(outcome.refused).toBe(true);
    expect(await traces(conversation_id)).toEqual({ messages: 0, turns: 0, tasks: 0 });
  });
  test("tasks of a run are hidden from, and cannot be cancelled by, another person", async () => {
    const admin = { ...principal, roles: ["admin"] };
    const conversation_id = await runConversation();
    const appended = await handleConversationTool({
      db: testDb.db,
      principal: admin,
      name: "conversation_append",
      args: { conversation_id, message: "status?" },
    });
    expect(appended.isError).toBe(false);
    const [task] = await testDb.db
      .select({ id: mcpTasks.id })
      .from(mcpTasks)
      .where(
        and(
          eq(mcpTasks.tenant_id, principal.tenant_id),
          eq(mcpTasks.conversation_id, conversation_id),
        ),
      );
    if (!task) throw new Error("expected a task row");
    const asStranger = new ConversationTaskStore({
      db: testDb.db,
      tenant_id: principal.tenant_id,
      principal: stranger,
    });
    const anonymous = new ConversationTaskStore({ db: testDb.db, tenant_id: principal.tenant_id });
    const asAdmin = new ConversationTaskStore({
      db: testDb.db,
      tenant_id: principal.tenant_id,
      principal: admin,
    });
    for (const store of [asStranger, anonymous]) {
      expect(await store.getTask(task.id)).toBeNull();
      await expect(store.getTaskResult(task.id)).rejects.toThrow("task not found");
      expect((await store.listTasks()).tasks.map((row) => row.taskId)).not.toContain(task.id);
      await expect(store.updateTaskStatus(task.id, "cancelled")).rejects.toMatchObject({
        code: "task_run_write_forbidden",
      });
    }
    expect((await asAdmin.getTask(task.id))?.taskId).toBe(task.id);
    expect((await asAdmin.listTasks()).tasks.map((row) => row.taskId)).toContain(task.id);
    await asAdmin.updateTaskStatus(task.id, "cancelled");
    expect((await asAdmin.getTask(task.id))?.status).toBe("cancelled");
  });

  test("tasks of an ordinary conversation stay visible and cancellable as before", async () => {
    const started = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_start",
      args: { message: "list users" },
    });
    const body = JSON.parse(started.content[0]?.text ?? "{}") as { mcp_task_id: string };
    const anonymous = new ConversationTaskStore({ db: testDb.db, tenant_id: principal.tenant_id });
    expect((await anonymous.getTask(body.mcp_task_id))?.taskId).toBe(body.mcp_task_id);
    expect((await anonymous.listTasks()).tasks.map((row) => row.taskId)).toContain(
      body.mcp_task_id,
    );
    await anonymous.updateTaskStatus(body.mcp_task_id, "cancelled");
    expect((await anonymous.getTask(body.mcp_task_id))?.status).toBe("cancelled");
  });
});
