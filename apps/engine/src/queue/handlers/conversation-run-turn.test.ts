import { describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import * as svc from "../../conversations/service.ts";
import { auditLog, conversations, mcpTasks } from "../../db/schema/index.ts";
import { getMockProvider } from "../../llm/mock-provider.ts";
import { withContext } from "../../logging/context.ts";
import {
  getMcpTask,
  insertMcpTask,
  rearmMcpTaskForNativeElicitation,
  setMcpTaskCancelled,
  setMcpTaskJobId,
  setMcpTaskResult,
  setMcpTaskResultIfCurrentAttempt,
} from "../../mcp/tasks/store.ts";
import { ConversationTaskStore } from "../../mcp/tasks/task-store.ts";
import { flush, waitFor } from "../../test-helpers/determinism/wait.ts";
import { enqueueConversationRunTurn as enqueueRawConversationRunTurn } from "./conversation-run-turn.ts";
import {
  enqueueConversationRunTurn,
  nextUuid,
  queue,
  queuedPrincipal,
  seedConversationAndTask,
  tenantId,
  useRunTurnQueue,
  userId,
  waitForTerminal,
} from "./conversation-run-turn-fixtures.ts";

useRunTurnQueue();

describe("conversation.run-turn worker", () => {
  test("task stores trusted origin and trace independently of request source", async () => {
    const { mcp_task_id } = await withContext(
      { audit_origin_source: "ui", audit_trace_id: "server-trace-conversation" },
      () => seedConversationAndTask("record trusted provenance"),
    );
    const task = await getMcpTask(tenantId, mcp_task_id, queue.testDb.db);
    expect(task).toMatchObject({
      request_source: "mcp",
      origin_source: "ui",
      audit_trace_id: "server-trace-conversation",
    });
  });

  test("missing queued principal uses the persisted task caller for audit attribution", async () => {
    const { conversation_id, mcp_task_id } =
      await seedConversationAndTask("deny missing principal");
    await enqueueRawConversationRunTurn(queue.boss, queue.testDb.db, {
      tenant_id: tenantId,
      conversation_id,
      mcp_task_id,
      actor_id: userId,
      principal: null,
      kind: "start",
    });
    await waitForTerminal(mcp_task_id);

    await waitFor(
      async () => {
        const rows = await queue.testDb.db
          .select({ action: auditLog.action })
          .from(auditLog)
          .where(
            and(
              eq(auditLog.tenant_id, tenantId),
              inArray(auditLog.action, ["policy.denied", "conversation.turn_failed"]),
              eq(auditLog.resource_id, conversation_id),
            ),
          );
        return new Set(rows.map((row) => row.action)).size === 2;
      },
      { tries: 80, sleepMs: 25, label: "missing-principal denial audit rows" },
    );

    const denials = await queue.testDb.db
      .select({
        action: auditLog.action,
        actor_type: auditLog.actor_type,
        actor_id: auditLog.actor_id,
        reason: auditLog.reason,
      })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenantId),
          inArray(auditLog.action, ["policy.denied", "conversation.turn_failed"]),
          eq(auditLog.resource_id, conversation_id),
        ),
      );
    expect(denials).toHaveLength(2);
    expect(denials).toContainEqual({
      action: "policy.denied",
      actor_type: "user",
      actor_id: userId,
      reason: "execution_authentication_unavailable",
    });
    expect(denials).toContainEqual({
      action: "conversation.turn_failed",
      actor_type: "user",
      actor_id: userId,
      reason: "Queued conversation requires authenticated credential provenance.",
    });
  }, 20_000);

  test("cross-tenant queued principal does not override persisted task caller", async () => {
    const { conversation_id, mcp_task_id } = await seedConversationAndTask(
      "deny cross-tenant principal",
    );
    const foreignPrincipal = {
      ...queuedPrincipal,
      id: userId,
      tenant_id: nextUuid(),
    };
    await enqueueRawConversationRunTurn(queue.boss, queue.testDb.db, {
      tenant_id: tenantId,
      conversation_id,
      mcp_task_id,
      actor_id: userId,
      principal: foreignPrincipal,
      kind: "start",
    });
    await waitForTerminal(mcp_task_id);

    await waitFor(
      async () => {
        const rows = await queue.testDb.db
          .select({ action: auditLog.action })
          .from(auditLog)
          .where(
            and(
              eq(auditLog.tenant_id, tenantId),
              inArray(auditLog.action, ["policy.denied", "conversation.turn_failed"]),
              eq(auditLog.resource_id, conversation_id),
            ),
          );
        return new Set(rows.map((row) => row.action)).size === 2;
      },
      { tries: 80, sleepMs: 25, label: "cross-tenant denial audit rows" },
    );

    const denials = await queue.testDb.db
      .select({
        action: auditLog.action,
        actor_type: auditLog.actor_type,
        actor_id: auditLog.actor_id,
      })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenantId),
          inArray(auditLog.action, ["policy.denied", "conversation.turn_failed"]),
          eq(auditLog.resource_id, conversation_id),
        ),
      );
    expect(denials).toHaveLength(2);
    expect(denials).toHaveLength(2);
    expect(denials.every((entry) => entry.actor_type === "user" && entry.actor_id === userId)).toBe(
      true,
    );
  }, 20_000);

  test("a start job runs the turn and writes the terminal envelope into mcp_tasks.result", async () => {
    const { conversation_id, mcp_task_id } = await seedConversationAndTask("list users");
    await enqueueConversationRunTurn(queue.boss, {
      tenant_id: tenantId,
      conversation_id,
      mcp_task_id,
      actor_id: userId,
      kind: "start",
    });
    await waitForTerminal(mcp_task_id);
    const row = await getMcpTask(tenantId, mcp_task_id, queue.testDb.db);
    expect(row?.result).toBeTruthy();
    expect(row?.result?.conversation_id).toBe(conversation_id);
    expect(row?.failure_reason).toBeNull();
  }, 45_000);

  test("a job whose mcp_tasks row is already terminal is an idempotent no-op", async () => {
    const { conversation_id, mcp_task_id } = await seedConversationAndTask("list users");
    await setMcpTaskResult(
      tenantId,
      mcp_task_id,
      { conversation_id, status: "active", events: [{ marker: "pre-seeded" }] },
      queue.testDb.db,
    );
    await enqueueConversationRunTurn(queue.boss, {
      tenant_id: tenantId,
      conversation_id,
      mcp_task_id,
      actor_id: userId,
      kind: "start",
    });
    for (let i = 0; i < 12; i++) await flush();
    await waitFor(async () => true, { tries: 8, sleepMs: 250, label: "worker dequeue window" });
    const row = await getMcpTask(tenantId, mcp_task_id, queue.testDb.db);
    const events = (row?.result?.events ?? []) as Array<{ marker?: string }>;
    expect(events[0]?.marker).toBe("pre-seeded");
  }, 20_000);

  test("turn_seq increments monotonically per conversation", async () => {
    const created = await svc.createConversation(
      { tenant_id: tenantId, actor_id: userId, initial_message: "hello" },
      queue.testDb.db,
    );
    const first = await insertMcpTask(
      {
        tenant_id: tenantId,
        conversation_id: created.conversation.id,
        kind: "start",
        actor: { kind: "user", id: userId },
        request_source: "mcp",
        user_message_id: created.initial_message_id,
      },
      queue.testDb.db,
    );
    const second = await insertMcpTask(
      {
        tenant_id: tenantId,
        conversation_id: created.conversation.id,
        kind: "append",
        actor: { kind: "user", id: userId },
        request_source: "mcp",
        user_message_id: null,
      },
      queue.testDb.db,
    );
    const [r1] = await queue.testDb.db
      .select({ turn_seq: mcpTasks.turn_seq })
      .from(mcpTasks)
      .where(eq(mcpTasks.id, first));
    const [r2] = await queue.testDb.db
      .select({ turn_seq: mcpTasks.turn_seq })
      .from(mcpTasks)
      .where(eq(mcpTasks.id, second));
    expect(r1?.turn_seq).toBe(1);
    expect(r2?.turn_seq).toBe(2);
  });

  test("a pausing attempt cannot overwrite the native-resume attempt on a reused task id", async () => {
    const { conversation_id, mcp_task_id } = await seedConversationAndTask("resume fence");
    const pausingAttempt = "00000000-0000-4000-8000-000000000101";
    const resumedAttempt = "00000000-0000-4000-8000-000000000102";
    await setMcpTaskJobId(tenantId, mcp_task_id, pausingAttempt, queue.testDb.db);

    expect(
      await rearmMcpTaskForNativeElicitation(
        { tenant_id: tenantId, task_id: mcp_task_id, actor: { kind: "user", id: userId } },
        queue.testDb.db,
      ),
    ).toBe(true);
    await setMcpTaskJobId(tenantId, mcp_task_id, resumedAttempt, queue.testDb.db);

    expect(
      await setMcpTaskResultIfCurrentAttempt(
        tenantId,
        mcp_task_id,
        pausingAttempt,
        { conversation_id, status: "awaiting_input", events: [{ marker: "stale" }] },
        queue.testDb.db,
      ),
    ).toBe(false);
    expect(
      await setMcpTaskResultIfCurrentAttempt(
        tenantId,
        mcp_task_id,
        resumedAttempt,
        { conversation_id, status: "active", events: [{ marker: "resumed" }] },
        queue.testDb.db,
      ),
    ).toBe(true);

    const row = await getMcpTask(tenantId, mcp_task_id, queue.testDb.db);
    expect(row?.job_id).toBe(resumedAttempt);
    expect((row?.result?.events as Array<{ marker?: string }> | undefined)?.[0]?.marker).toBe(
      "resumed",
    );
  });
});

describe("conversation.run-turn worker — cancel", () => {
  test("a job whose mcp_tasks row already has cancelled_at is an idempotent no-op", async () => {
    const { conversation_id, mcp_task_id } = await seedConversationAndTask("cancel before start");
    await setMcpTaskCancelled(tenantId, mcp_task_id, queue.testDb.db);

    await enqueueConversationRunTurn(queue.boss, {
      tenant_id: tenantId,
      conversation_id,
      mcp_task_id,
      actor_id: userId,
      kind: "start",
    });
    for (let i = 0; i < 12; i++) await flush();
    await waitFor(async () => true, { tries: 8, sleepMs: 250, label: "worker dequeue window" });

    const row = await getMcpTask(tenantId, mcp_task_id, queue.testDb.db);
    expect(row?.cancelled_at).toBeInstanceOf(Date);
    expect(row?.result).toBeNull();
    expect(row?.failure_reason).toBeNull();

    const store = new ConversationTaskStore({ db: queue.testDb.db, tenant_id: tenantId });
    const task = await store.getTask(mcp_task_id);
    expect(task?.status).toBe("cancelled");
  }, 20_000);
});

describe("conversation.run-turn worker — elicitation pause", () => {
  test("a turn that pauses on ask_user_* finishes the job but the task derives input_required", async () => {
    const created = await svc.createConversation(
      { tenant_id: tenantId, actor_id: userId, initial_message: "list users from the api" },
      queue.testDb.db,
    );
    const conversation_id = created.conversation.id;
    getMockProvider().setConversePlan(conversation_id, [
      {
        tool: "ask_user_confirm",
        args: {
          question: "Confirm the destructive test checkpoint?",
          kind: "generic",
          summary: "confirm destructive checkpoint",
          destructive: true,
        },
      },
    ]);
    const mcp_task_id = await insertMcpTask(
      {
        tenant_id: tenantId,
        conversation_id,
        kind: "start",
        actor: { kind: "user", id: userId },
        request_source: "mcp",
        user_message_id: created.initial_message_id,
      },
      queue.testDb.db,
    );
    await enqueueConversationRunTurn(queue.boss, {
      tenant_id: tenantId,
      conversation_id,
      mcp_task_id,
      actor_id: userId,
      kind: "start",
    });
    await waitForTerminal(mcp_task_id);

    const row = await getMcpTask(tenantId, mcp_task_id, queue.testDb.db);
    expect(row?.result).toBeTruthy();
    expect(row?.failure_reason).toBeNull();
    const [conv] = await queue.testDb.db
      .select({ status: conversations.status })
      .from(conversations)
      .where(eq(conversations.id, conversation_id));
    expect(conv?.status).toBe("awaiting_input");
    const store = new ConversationTaskStore({ db: queue.testDb.db, tenant_id: tenantId });
    const task = await store.getTask(mcp_task_id);
    expect(task?.status).toBe("input_required");
  }, 45_000);
});

describe("conversation.run-turn worker — cancel in the guard window", () => {
  test("a cancel landing in the guard window still stops the turn — no result written", async () => {
    const created = await svc.createConversation(
      { tenant_id: tenantId, actor_id: userId, initial_message: "list users" },
      queue.testDb.db,
    );
    const conversation_id = created.conversation.id;
    const mcp_task_id = await insertMcpTask(
      {
        tenant_id: tenantId,
        conversation_id,
        kind: "start",
        actor: { kind: "user", id: userId },
        request_source: "mcp",
        user_message_id: created.initial_message_id,
      },
      queue.testDb.db,
    );
    const store = new ConversationTaskStore({ db: queue.testDb.db, tenant_id: tenantId });
    await store.updateTaskStatus(mcp_task_id, "cancelled");

    await enqueueConversationRunTurn(queue.boss, {
      tenant_id: tenantId,
      conversation_id,
      mcp_task_id,
      actor_id: userId,
      kind: "start",
    });
    for (let i = 0; i < 12; i++) await flush();
    await waitFor(async () => true, { tries: 12, sleepMs: 250, label: "worker dequeue window" });

    const row = await getMcpTask(tenantId, mcp_task_id, queue.testDb.db);
    expect(row?.cancelled_at).toBeInstanceOf(Date);
    expect(row?.result).toBeNull();
    expect(row?.failure_reason).toBeNull();
    expect((await store.getTask(mcp_task_id))?.status).toBe("cancelled");
  }, 30_000);
});
