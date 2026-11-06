import { describe, expect, spyOn, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { createElicitation } from "../../conversations/elicitations.ts";
import { _setConverseFirstChunkTimeoutMsForTests } from "../../conversations/loop/index.ts";
import * as svc from "../../conversations/service.ts";
import { auditLog, users } from "../../db/schema/index.ts";
import { getMockProvider, resetMockProvider } from "../../llm/mock-provider.ts";
import {
  getMcpTask,
  insertMcpTask,
  setMcpTaskParked,
  setMcpTaskResult,
} from "../../mcp/tasks/store.ts";
import { ConversationTaskStore } from "../../mcp/tasks/task-store.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import { SUPERSEDED_WHILE_PARKED_FAILURE_REASON } from "./conversation-run-turn.ts";
import {
  enqueueConversationRunTurn,
  queue,
  seedConversationAndTask,
  tenantId,
  useRunTurnQueue,
  userId,
  waitForTerminal,
} from "./conversation-run-turn-fixtures.ts";

useRunTurnQueue();

describe("conversation.run-turn worker — respond_elicitation surface threading", () => {
  test("a failed portal continuation retains the verified approver as its actor", async () => {
    const [approver] = await queue.testDb.db
      .insert(users)
      .values({
        tenant_id: tenantId,
        email: "portal-approver@test.local",
        role_id: await builtinRoleId(queue.testDb.db, "admin"),
      })
      .returning({ id: users.id });
    if (!approver) throw new Error("seed portal approver failed");
    const created = await svc.createConversation(
      { tenant_id: tenantId, actor_id: userId, initial_message: "portal failure seed" },
      queue.testDb.db,
    );
    const elicitation = await createElicitation(
      {
        tenant_id: tenantId,
        conversation_id: created.conversation.id,
        tool_call_id: null,
        tool_name: "ask_user_text",
        summary: "portal failure probe",
        input: { question: "probe?" },
        actor_id: userId,
      },
      queue.testDb.db,
    );
    const mcp_task_id = await insertMcpTask(
      {
        tenant_id: tenantId,
        conversation_id: created.conversation.id,
        kind: "respond_elicitation",
        actor: { kind: "user", id: userId },
        request_source: "portal",
        user_message_id: null,
      },
      queue.testDb.db,
    );
    const spy = spyOn(svc, "respondElicitation").mockRejectedValue(
      new Error("portal continuation failed"),
    );
    try {
      await enqueueConversationRunTurn(queue.boss, {
        tenant_id: tenantId,
        conversation_id: created.conversation.id,
        mcp_task_id,
        actor_id: approver.id,
        kind: "respond_elicitation",
        elicitation_id: elicitation.id,
        answer_channel: "portal",
        approver_user_id: approver.id,
      });
      await waitForTerminal(mcp_task_id);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }

    await waitFor(
      async () => {
        const [row] = await queue.testDb.db
          .select({ id: auditLog.id })
          .from(auditLog)
          .where(
            and(
              eq(auditLog.tenant_id, tenantId),
              eq(auditLog.action, "conversation.turn_failed"),
              eq(auditLog.resource_id, created.conversation.id),
            ),
          );
        return Boolean(row);
      },
      { tries: 80, sleepMs: 25, label: "portal failure audit row" },
    );

    const [audit] = await queue.testDb.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenantId),
          eq(auditLog.action, "conversation.turn_failed"),
          eq(auditLog.resource_id, created.conversation.id),
        ),
      );
    expect(audit?.actor_type).toBe("user");
    expect(audit?.actor_id).toBe(approver.id);
  }, 30_000);

  test("a disabled portal approver is unknown in a pre-response failure audit", async () => {
    const [approver] = await queue.testDb.db
      .insert(users)
      .values({
        tenant_id: tenantId,
        email: "disabled-portal-approver@test.local",
        role_id: await builtinRoleId(queue.testDb.db, "admin"),
        status: "disabled",
      })
      .returning({ id: users.id });
    if (!approver) throw new Error("seed disabled portal approver failed");
    const created = await svc.createConversation(
      { tenant_id: tenantId, actor_id: userId, initial_message: "disabled portal failure seed" },
      queue.testDb.db,
    );
    const elicitation = await createElicitation(
      {
        tenant_id: tenantId,
        conversation_id: created.conversation.id,
        tool_call_id: null,
        tool_name: "ask_user_text",
        summary: "disabled portal failure probe",
        input: { question: "probe?" },
        actor_id: userId,
      },
      queue.testDb.db,
    );
    const mcp_task_id = await insertMcpTask(
      {
        tenant_id: tenantId,
        conversation_id: created.conversation.id,
        kind: "respond_elicitation",
        actor: { kind: "user", id: userId },
        request_source: "portal",
        user_message_id: null,
      },
      queue.testDb.db,
    );
    const spy = spyOn(svc, "respondElicitation").mockRejectedValue(
      new Error("authorization failed before response"),
    );
    try {
      await enqueueConversationRunTurn(queue.boss, {
        tenant_id: tenantId,
        conversation_id: created.conversation.id,
        mcp_task_id,
        actor_id: approver.id,
        kind: "respond_elicitation",
        elicitation_id: elicitation.id,
        answer_channel: "portal",
        approver_user_id: approver.id,
      });
      await waitForTerminal(mcp_task_id);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }

    const [audit] = await queue.testDb.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenantId),
          eq(auditLog.action, "conversation.turn_failed"),
          eq(auditLog.resource_id, created.conversation.id),
        ),
      );
    expect(audit?.actor_type).toBe("unknown");
    expect(audit?.actor_id).toBeNull();
  }, 30_000);

  test("the respond branch passes surface:'mcp' into respondElicitation", async () => {
    const created = await svc.createConversation(
      { tenant_id: tenantId, actor_id: userId, initial_message: "respond surface seed" },
      queue.testDb.db,
    );
    const conversation_id = created.conversation.id;
    const elicitation = await createElicitation(
      {
        tenant_id: tenantId,
        conversation_id,
        tool_call_id: null,
        tool_name: "ask_user_text",
        summary: "surface probe",
        input: { question: "probe?" },
        actor_id: userId,
      },
      queue.testDb.db,
    );
    const mcp_task_id = await insertMcpTask(
      {
        tenant_id: tenantId,
        conversation_id,
        kind: "respond_elicitation",
        actor: { kind: "user", id: userId },
        request_source: "mcp",
        user_message_id: null,
      },
      queue.testDb.db,
    );

    const captured: svc.RespondElicitationParams[] = [];
    const spy = spyOn(svc, "respondElicitation").mockImplementation(async (p) => {
      captured.push(p);
      return {
        conversation: created.conversation,
        result: { events: [], status: "active" as const },
      };
    });
    try {
      await enqueueConversationRunTurn(queue.boss, {
        tenant_id: tenantId,
        conversation_id,
        mcp_task_id,
        actor_id: userId,
        kind: "respond_elicitation",
        elicitation_id: elicitation.id,
      });
      await waitForTerminal(mcp_task_id);
    } finally {
      spy.mockRestore();
    }

    expect(captured).toHaveLength(1);
    expect(captured[0]?.surface).toBe("mcp");
    expect(captured[0]?.elicitation_id).toBe(elicitation.id);
    expect(captured[0]?.conversation_id).toBe(conversation_id);
  }, 30_000);

  test("mcp_native provenance becomes a human in-band answer and cannot come from tool args", async () => {
    const created = await svc.createConversation(
      { tenant_id: tenantId, actor_id: userId, initial_message: "native answer seed" },
      queue.testDb.db,
    );
    const conversation_id = created.conversation.id;
    const elicitation = await createElicitation(
      {
        tenant_id: tenantId,
        conversation_id,
        tool_call_id: null,
        tool_name: "ask_user_confirm",
        summary: "approve native action",
        input: { question: "Approve?" },
        actor_id: userId,
      },
      queue.testDb.db,
    );
    const mcp_task_id = await insertMcpTask(
      {
        tenant_id: tenantId,
        conversation_id,
        kind: "respond_elicitation",
        actor: { kind: "user", id: userId },
        request_source: "mcp",
        user_message_id: null,
      },
      queue.testDb.db,
    );
    const principal = {
      kind: "user" as const,
      id: userId,
      tenant_id: tenantId,
      provider: "api_key" as const,
      roles: ["admin"],
    };
    const captured: svc.RespondElicitationParams[] = [];
    const spy = spyOn(svc, "respondElicitation").mockImplementation(async (p) => {
      captured.push(p);
      return {
        conversation: created.conversation,
        result: { events: [], status: "active" as const },
      };
    });
    try {
      await enqueueConversationRunTurn(queue.boss, {
        tenant_id: tenantId,
        conversation_id,
        mcp_task_id,
        actor_id: userId,
        principal,
        kind: "respond_elicitation",
        elicitation_id: elicitation.id,
        answer_channel: "mcp_native",
      });
      await waitForTerminal(mcp_task_id);
    } finally {
      spy.mockRestore();
    }
    expect(captured[0]?.answer_actor).toEqual({
      kind: "human",
      user_id: userId,
      via: "in_band_elicitation",
    });
  }, 30_000);
});

describe("conversation.run-turn worker — concurrent turns (B2)", () => {
  test("a queued turn rejects another enqueue for the same dialog", async () => {
    const created = await svc.createConversation(
      { tenant_id: tenantId, actor_id: userId, initial_message: "concurrent turn seed" },
      queue.testDb.db,
    );
    const conversation_id = created.conversation.id;
    getMockProvider().setConversePlan(conversation_id, []);
    const appendA = await svc.appendUserMessage(
      { tenant_id: tenantId, conversation_id, actor_id: userId, message: "MESSAGE-ALPHA" },
      queue.testDb.db,
    );
    const taskA = await insertMcpTask(
      {
        tenant_id: tenantId,
        conversation_id,
        kind: "append",
        actor: { kind: "user", id: userId },
        request_source: "mcp",
        user_message_id: appendA.message_id,
      },
      queue.testDb.db,
    );
    await enqueueConversationRunTurn(queue.boss, {
      tenant_id: tenantId,
      conversation_id,
      mcp_task_id: taskA,
      actor_id: userId,
      kind: "append",
    });
    await expect(
      svc.appendUserMessage(
        { tenant_id: tenantId, conversation_id, actor_id: userId, message: "MESSAGE-BRAVO" },
        queue.testDb.db,
      ),
    ).rejects.toMatchObject({ code: "conversation_turn_in_progress" });
    await waitForTerminal(taskA);
    const row = await getMcpTask(tenantId, taskA, queue.testDb.db);
    const events = row?.result?.events as Array<{
      type?: string;
      role?: string;
      content?: { text?: string };
    }>;
    expect(
      events.find((event) => event.type === "message" && event.role === "user")?.content?.text,
    ).toBe("MESSAGE-ALPHA");
  }, 30_000);
});

describe("conversation.run-turn worker — parked turn supersession", () => {
  async function completeLaterTurn(conversation_id: string): Promise<void> {
    const laterId = await insertMcpTask(
      {
        tenant_id: tenantId,
        conversation_id,
        kind: "append",
        actor: { kind: "user", id: userId },
        request_source: "mcp",
        user_message_id: null,
      },
      queue.testDb.db,
    );
    await setMcpTaskResult(
      tenantId,
      laterId,
      { conversation_id, status: "active", events: [{ marker: "later-turn" }] },
      queue.testDb.db,
    );
  }

  test("a parked turn the conversation outran is not run — stamped superseded, the model is never called", async () => {
    const { conversation_id, mcp_task_id } = await seedConversationAndTask("outrun me");
    await setMcpTaskParked(
      tenantId,
      mcp_task_id,
      new Date(getTestNow() - 1_000),
      "provider_quota_exhausted",
      queue.testDb.db,
    );
    await completeLaterTurn(conversation_id);

    getMockProvider().setFailure("runturn-primary", "quota_exhausted");
    getMockProvider().setFailure("runturn-fallback", "quota_exhausted");
    try {
      await enqueueConversationRunTurn(queue.boss, {
        tenant_id: tenantId,
        conversation_id,
        mcp_task_id,
        actor_id: userId,
        kind: "start",
        provider_limit_parks: 1,
      });
      await waitForTerminal(mcp_task_id);
    } finally {
      resetMockProvider();
    }

    const row = await getMcpTask(tenantId, mcp_task_id, queue.testDb.db);
    expect(row?.failure_reason).toBe(SUPERSEDED_WHILE_PARKED_FAILURE_REASON);
    expect(row?.result).toBeNull();
    expect(row?.parked_reason).toBe("provider_quota_exhausted");
  }, 45_000);

  test("a parked turn with no later completed turn resumes normally", async () => {
    const { conversation_id, mcp_task_id } = await seedConversationAndTask("resume me");
    await setMcpTaskParked(
      tenantId,
      mcp_task_id,
      new Date(getTestNow() - 1_000),
      "provider_quota_exhausted",
      queue.testDb.db,
    );

    await enqueueConversationRunTurn(queue.boss, {
      tenant_id: tenantId,
      conversation_id,
      mcp_task_id,
      actor_id: userId,
      kind: "start",
      provider_limit_parks: 1,
    });
    await waitForTerminal(mcp_task_id);

    const row = await getMcpTask(tenantId, mcp_task_id, queue.testDb.db);
    expect(row?.result).not.toBeNull();
    expect(row?.failure_reason).toBeNull();
    expect(row?.parked_until).toBeNull();
  }, 45_000);

  test("an unparked turn is never superseded, even with a later completed turn", async () => {
    const { conversation_id, mcp_task_id } = await seedConversationAndTask("queued behind");
    await completeLaterTurn(conversation_id);

    await enqueueConversationRunTurn(queue.boss, {
      tenant_id: tenantId,
      conversation_id,
      mcp_task_id,
      actor_id: userId,
      kind: "start",
    });
    await waitForTerminal(mcp_task_id);

    const row = await getMcpTask(tenantId, mcp_task_id, queue.testDb.db);
    expect(row?.result).not.toBeNull();
    expect(row?.failure_reason).toBeNull();
  }, 45_000);

  test("a raw SDK timeout becomes the shared timeout wording in failure_reason and the tool result", async () => {
    const { conversation_id, mcp_task_id } =
      await seedConversationAndTask("hang on the first chunk");
    const sdkTimeout = new Error("First chunk timeout of 90000ms exceeded");
    sdkTimeout.name = "TimeoutError";
    const spy = spyOn(svc, "runConversationTurn").mockImplementation(async () => {
      throw sdkTimeout;
    });
    try {
      await enqueueConversationRunTurn(queue.boss, {
        tenant_id: tenantId,
        conversation_id,
        mcp_task_id,
        actor_id: userId,
        kind: "start",
      });
      await waitForTerminal(mcp_task_id);
    } finally {
      spy.mockRestore();
    }

    const row = await getMcpTask(tenantId, mcp_task_id, queue.testDb.db);
    expect(row?.failure_reason).toBe("Timed out after 90 s");
    expect(row?.result).toBeNull();

    const store = new ConversationTaskStore({ db: queue.testDb.db, tenant_id: tenantId });
    const result = await store.getTaskResult(mcp_task_id);
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "Timed out after 90 s" }]);
  }, 45_000);

  test("a provider that never sends its first chunk fails the MCP turn with the same wording the loop uses", async () => {
    const { conversation_id, mcp_task_id } = await seedConversationAndTask("silent provider");
    getMockProvider().setFailure("runturn-primary", "stream_never_answers");
    _setConverseFirstChunkTimeoutMsForTests(200);
    try {
      await enqueueConversationRunTurn(queue.boss, {
        tenant_id: tenantId,
        conversation_id,
        mcp_task_id,
        actor_id: userId,
        kind: "start",
      });
      await waitForTerminal(mcp_task_id);
    } finally {
      _setConverseFirstChunkTimeoutMsForTests(null);
    }

    const row = await getMcpTask(tenantId, mcp_task_id, queue.testDb.db);
    expect(row?.failure_reason).toBe("Timed out after 1 s");
    const store = new ConversationTaskStore({ db: queue.testDb.db, tenant_id: tenantId });
    expect(await store.getTaskResult(mcp_task_id)).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "Timed out after 1 s" }],
    });
  }, 45_000);
});
