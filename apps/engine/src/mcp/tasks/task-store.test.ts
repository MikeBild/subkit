import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  conversationElicitations,
  conversations,
  mcpTasks,
  tenants,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import { ConversationTaskStore } from "./task-store.ts";

let testDb: TestDb;
let tenantId: string;
let otherTenantId: string;

beforeAll(async () => {
  testDb = await createTestDb("mcp_task_store");
  const [t] = await testDb.db
    .insert(tenants)
    .values({ slug: "t-taskstore", display_name: "TaskStore" })
    .returning();
  if (!t) throw new Error("seed tenant failed");
  tenantId = t.id;
  const [t2] = await testDb.db
    .insert(tenants)
    .values({ slug: "t-taskstore-other", display_name: "Other" })
    .returning();
  if (!t2) throw new Error("seed other tenant failed");
  otherTenantId = t2.id;
});

afterAll(async () => {
  await testDb.cleanup();
});

async function seedConversation(
  status: "active" | "awaiting_input" | "committed",
): Promise<string> {
  const [conv] = await testDb.db
    .insert(conversations)
    .values({ tenant_id: tenantId, status, draft: {} })
    .returning();
  if (!conv) throw new Error("seed conversation failed");
  return conv.id;
}

async function seedTask(
  conversation_id: string,
  overrides: Partial<{
    result: unknown;
    failure_reason: string;
    cancelled_at: Date;
    tenant_id: string;
    kind: "start" | "append" | "respond_elicitation";
    turn_seq: number;
  }> = {},
): Promise<string> {
  const [row] = await testDb.db
    .insert(mcpTasks)
    .values({
      tenant_id: overrides.tenant_id ?? tenantId,
      conversation_id,
      turn_seq: overrides.turn_seq ?? 1,
      kind: overrides.kind ?? "start",
      actor_id: null,
      request_source: "mcp",
      ...(overrides.result !== undefined
        ? { result: overrides.result as Record<string, unknown> }
        : {}),
      ...(overrides.failure_reason ? { failure_reason: overrides.failure_reason } : {}),
      ...(overrides.cancelled_at ? { cancelled_at: overrides.cancelled_at } : {}),
    })
    .returning();
  if (!row) throw new Error("seed mcp_task failed");
  return row.id;
}

describe("ConversationTaskStore.getTask — status derivation", () => {
  test("nothing set → working", async () => {
    const conv = await seedConversation("active");
    const taskId = await seedTask(conv);
    const store = new ConversationTaskStore({ db: testDb.db, tenant_id: tenantId });
    const task = await store.getTask(taskId);
    expect(task?.status).toBe("working");
  });

  test("failure_reason set → failed", async () => {
    const conv = await seedConversation("active");
    const taskId = await seedTask(conv, { failure_reason: "llm_timeout" });
    const store = new ConversationTaskStore({ db: testDb.db, tenant_id: tenantId });
    const task = await store.getTask(taskId);
    expect(task?.status).toBe("failed");
    expect(task?.statusMessage).toBe("llm_timeout");
  });

  test("cancelled_at set → cancelled", async () => {
    const conv = await seedConversation("active");
    const taskId = await seedTask(conv, { cancelled_at: new Date(FROZEN_NOW) });
    const store = new ConversationTaskStore({ db: testDb.db, tenant_id: tenantId });
    const task = await store.getTask(taskId);
    expect(task?.status).toBe("cancelled");
  });

  test("result set, no pending elicitation → completed", async () => {
    const conv = await seedConversation("committed");
    const taskId = await seedTask(conv, {
      result: { conversation_id: conv, status: "committed", events: [] },
    });
    const store = new ConversationTaskStore({ db: testDb.db, tenant_id: tenantId });
    const task = await store.getTask(taskId);
    expect(task?.status).toBe("completed");
  });

  test("conversation awaiting_input + pending elicitation → input_required (even with result set)", async () => {
    const conv = await seedConversation("awaiting_input");
    await testDb.db.insert(conversationElicitations).values({
      tenant_id: tenantId,
      conversation_id: conv,
      tool_name: "ask_user_confirm",
      summary: "confirm",
      input: { kind: "generic" },
      status: "pending",
    });
    const taskId = await seedTask(conv, {
      result: { conversation_id: conv, status: "awaiting_input", events: [] },
    });
    const store = new ConversationTaskStore({ db: testDb.db, tenant_id: tenantId });
    const task = await store.getTask(taskId);
    expect(task?.status).toBe("input_required");
  });

  test("a respond_elicitation turn still in flight derives working, not input_required", async () => {
    const conv = await seedConversation("awaiting_input");
    await testDb.db.insert(conversationElicitations).values({
      tenant_id: tenantId,
      conversation_id: conv,
      tool_name: "ask_user_confirm",
      summary: "confirm",
      input: { kind: "generic" },
      status: "pending",
    });
    const taskId = await seedTask(conv, { kind: "respond_elicitation" });
    const store = new ConversationTaskStore({ db: testDb.db, tenant_id: tenantId });
    const task = await store.getTask(taskId);
    expect(task?.status).toBe("working");
  });

  test("S2: a historical (non-latest turn_seq) completed task stays completed while a later turn is input_required", async () => {
    const conv = await seedConversation("awaiting_input");
    await testDb.db.insert(conversationElicitations).values({
      tenant_id: tenantId,
      conversation_id: conv,
      tool_name: "ask_user_confirm",
      summary: "confirm",
      input: { kind: "generic" },
      status: "pending",
    });
    const historical = await seedTask(conv, {
      turn_seq: 1,
      result: { conversation_id: conv, status: "active", events: [] },
    });
    const latest = await seedTask(conv, {
      turn_seq: 2,
      result: { conversation_id: conv, status: "awaiting_input", events: [] },
    });
    const store = new ConversationTaskStore({ db: testDb.db, tenant_id: tenantId });
    expect((await store.getTask(historical))?.status).toBe("completed");
    expect((await store.getTask(latest))?.status).toBe("input_required");
  });

  test("unknown taskId → null", async () => {
    const store = new ConversationTaskStore({ db: testDb.db, tenant_id: tenantId });
    const task = await store.getTask("00000000-0000-0000-0000-000000000000");
    expect(task).toBeNull();
  });

  test("tenant-scoped — a foreign tenant cannot read another tenant's task", async () => {
    const conv = await seedConversation("active");
    const taskId = await seedTask(conv);
    const foreignStore = new ConversationTaskStore({ db: testDb.db, tenant_id: otherTenantId });
    const task = await foreignStore.getTask(taskId);
    expect(task).toBeNull();
  });
});

describe("ConversationTaskStore.updateTaskStatus", () => {
  test("'cancelled' stamps cancelled_at and the task derives cancelled", async () => {
    const conv = await seedConversation("active");
    const taskId = await seedTask(conv);
    const store = new ConversationTaskStore({ db: testDb.db, tenant_id: tenantId });
    await store.updateTaskStatus(taskId, "cancelled");
    const [row] = await testDb.db
      .select({ cancelled_at: mcpTasks.cancelled_at })
      .from(mcpTasks)
      .where(eq(mcpTasks.id, taskId));
    expect(row?.cancelled_at).toBeInstanceOf(Date);
    const task = await store.getTask(taskId);
    expect(task?.status).toBe("cancelled");
  });

  test("'completed' is a derivation no-op (does not throw, does not mutate)", async () => {
    const conv = await seedConversation("active");
    const taskId = await seedTask(conv);
    const store = new ConversationTaskStore({ db: testDb.db, tenant_id: tenantId });
    await store.updateTaskStatus(taskId, "completed");
    const task = await store.getTask(taskId);
    expect(task?.status).toBe("working");
  });
});

describe("ConversationTaskStore.listTasks", () => {
  test("tenant-scoped — lists only the calling tenant's tasks", async () => {
    const conv = await seedConversation("active");
    await seedTask(conv);
    const store = new ConversationTaskStore({ db: testDb.db, tenant_id: tenantId });
    const { tasks } = await store.listTasks();
    expect(tasks.length).toBeGreaterThan(0);
    const foreign = new ConversationTaskStore({ db: testDb.db, tenant_id: otherTenantId });
    const foreignList = await foreign.listTasks();
    expect(foreignList.tasks.length).toBe(0);
  });
});

describe("ConversationTaskStore.getTaskResult — the tasks/result surface", () => {
  test("a completed task returns the terminal envelope as a non-error text body", async () => {
    const conv = await seedConversation("committed");
    const envelope = {
      conversation_id: conv,
      status: "committed",
      events: [{ type: "completed" }],
      committed_workflow_id: "wf_123",
    };
    const taskId = await seedTask(conv, { result: envelope });
    const store = new ConversationTaskStore({ db: testDb.db, tenant_id: tenantId });
    const result = (await store.getTaskResult(taskId)) as {
      content: Array<{ type: string; text: string }>;
      isError: boolean;
    };
    expect(result.isError).toBe(false);
    expect(result.content[0]?.type).toBe("text");
    expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual(envelope);
  });

  test("a completed no-op authoring turn does not synthesize committed_workflow_id", async () => {
    const conv = await seedConversation("active");
    const envelope = {
      conversation_id: conv,
      status: "active",
      events: [
        {
          type: "tool_result",
          tool: "save_workflow_draft",
          output: {
            ok: true,
            data: {
              already_persisted: true,
              version_changed: false,
              workflow_id: "wf_existing",
            },
          },
        },
      ],
    };
    const taskId = await seedTask(conv, { result: envelope });
    const store = new ConversationTaskStore({ db: testDb.db, tenant_id: tenantId });
    const task = await store.getTask(taskId);
    expect(task?.status).toBe("completed");
    const result = (await store.getTaskResult(taskId)) as {
      content: Array<{ type: string; text: string }>;
      isError: boolean;
    };
    expect(result.isError).toBe(false);
    const body = JSON.parse(result.content[0]?.text ?? "{}") as {
      committed_workflow_id?: string;
      events: Array<{ output?: { data?: { already_persisted?: boolean } } }>;
    };
    expect(body.committed_workflow_id).toBeUndefined();
    expect(body.events[0]?.output?.data?.already_persisted).toBe(true);
  });

  test("a failed task returns an isError text body carrying the failure reason", async () => {
    const conv = await seedConversation("active");
    const taskId = await seedTask(conv, { failure_reason: "llm_overloaded" });
    const store = new ConversationTaskStore({ db: testDb.db, tenant_id: tenantId });
    const result = (await store.getTaskResult(taskId)) as {
      content: Array<{ text: string }>;
      isError: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("llm_overloaded");
  });

  test("a non-terminal (working) task throws rather than returning an empty body", async () => {
    const conv = await seedConversation("active");
    const taskId = await seedTask(conv);
    const store = new ConversationTaskStore({ db: testDb.db, tenant_id: tenantId });
    await expect(store.getTaskResult(taskId)).rejects.toThrow(/no result yet/);
  });

  test("a foreign tenant cannot read another tenant's task result", async () => {
    const conv = await seedConversation("committed");
    const taskId = await seedTask(conv, {
      result: { conversation_id: conv, status: "committed", events: [] },
    });
    const foreign = new ConversationTaskStore({ db: testDb.db, tenant_id: otherTenantId });
    await expect(foreign.getTaskResult(taskId)).rejects.toThrow(/task not found/);
  });

  test("S5: a task with result set but deriving input_required refuses — not a success body", async () => {
    const conv = await seedConversation("awaiting_input");
    await testDb.db.insert(conversationElicitations).values({
      tenant_id: tenantId,
      conversation_id: conv,
      tool_name: "ask_user_confirm",
      summary: "confirm",
      input: { kind: "generic" },
      status: "pending",
    });
    const taskId = await seedTask(conv, {
      result: { conversation_id: conv, status: "awaiting_input", events: [] },
    });
    const store = new ConversationTaskStore({ db: testDb.db, tenant_id: tenantId });
    expect((await store.getTask(taskId))?.status).toBe("input_required");
    await expect(store.getTaskResult(taskId)).rejects.toThrow(/awaiting input/);
  });
});

describe("ConversationTaskStore.updateTaskStatus — cancel of a terminal task", () => {
  test("cancelling an already-completed task stamps cancelled_at without throwing", async () => {
    const conv = await seedConversation("committed");
    const taskId = await seedTask(conv, {
      result: { conversation_id: conv, status: "committed", events: [] },
    });
    const store = new ConversationTaskStore({ db: testDb.db, tenant_id: tenantId });
    const before = await store.getTask(taskId);
    expect(before?.status).toBe("completed");
    await store.updateTaskStatus(taskId, "cancelled");
    const after = await store.getTask(taskId);
    expect(after?.status).toBe("cancelled");
  });

  test("cancelling an unknown taskId throws task-not-found", async () => {
    const store = new ConversationTaskStore({ db: testDb.db, tenant_id: tenantId });
    await expect(
      store.updateTaskStatus("00000000-0000-0000-0000-000000000000", "cancelled"),
    ).rejects.toThrow(/task not found/);
  });

  test("a foreign tenant cannot cancel another tenant's task", async () => {
    const conv = await seedConversation("active");
    const taskId = await seedTask(conv);
    const foreign = new ConversationTaskStore({ db: testDb.db, tenant_id: otherTenantId });
    await expect(foreign.updateTaskStatus(taskId, "cancelled")).rejects.toThrow(/task not found/);
    const owner = new ConversationTaskStore({ db: testDb.db, tenant_id: tenantId });
    const task = await owner.getTask(taskId);
    expect(task?.status).toBe("working");
  });
});
