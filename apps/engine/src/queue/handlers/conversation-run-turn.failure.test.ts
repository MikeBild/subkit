import { describe, expect, spyOn, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { deriveConversationOutcome } from "../../conversations/lifecycle-view.ts";
import * as svc from "../../conversations/service.ts";
import { auditLog, conversations, systemAccounts } from "../../db/schema/index.ts";
import { getMockProvider, resetMockProvider } from "../../llm/mock-provider.ts";
import { getMcpTask, insertMcpTask, setMcpTaskFailure } from "../../mcp/tasks/store.ts";
import { ConversationTaskStore } from "../../mcp/tasks/task-store.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
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

async function conversationFailure(conversation_id: string) {
  const [row] = await queue.testDb.db
    .select({ status: conversations.status, last_turn_error: conversations.last_turn_error })
    .from(conversations)
    .where(and(eq(conversations.tenant_id, tenantId), eq(conversations.id, conversation_id)));
  if (!row) throw new Error("conversation missing");
  return {
    last_turn_error: row.last_turn_error,
    outcome: deriveConversationOutcome({
      status: row.status,
      last_message_role: "user",
      last_activity_at: null,
      last_turn_error: row.last_turn_error,
      now: 0,
    }),
  };
}

describe("conversation.run-turn worker — failure path", () => {
  test("a turn that throws writes failure_reason and emits a CONVERSATION_TURN_FAILED audit row", async () => {
    const created = await svc.createConversation(
      { tenant_id: tenantId, actor_id: userId, initial_message: "fail me" },
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
    getMockProvider().setFailure("runturn-primary", "overloaded");
    getMockProvider().setFailure("runturn-fallback", "overloaded");

    await enqueueConversationRunTurn(queue.boss, {
      tenant_id: tenantId,
      conversation_id,
      mcp_task_id,
      actor_id: userId,
      kind: "start",
    });
    await waitFor(
      async () => {
        const row = await getMcpTask(tenantId, mcp_task_id, queue.testDb.db);
        return Boolean(row?.failure_reason);
      },
      { tries: 80, sleepMs: 250, label: "mcp_task failure_reason" },
    );

    const row = await getMcpTask(tenantId, mcp_task_id, queue.testDb.db);
    expect(row?.failure_reason).toContain("overloaded");
    expect(row?.result).toBeNull();

    const store = new ConversationTaskStore({ db: queue.testDb.db, tenant_id: tenantId });
    const task = await store.getTask(mcp_task_id);
    expect(task?.status).toBe("failed");
    expect(task?.statusMessage).toContain("overloaded");

    const auditRows = async () =>
      await queue.testDb.db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenant_id, tenantId),
            eq(auditLog.action, "conversation.turn_failed"),
            eq(auditLog.resource_id, conversation_id),
          ),
        );
    await waitFor(async () => (await auditRows()).length > 0, {
      tries: 80,
      sleepMs: 250,
      label: "conversation.turn_failed audit row",
    });
    const audits = await auditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.result).toBe("error");
    expect(audits[0]?.reason).toContain("overloaded");
    expect((audits[0]!.metadata as { mcp_task_id?: string }).mcp_task_id).toBe(mcp_task_id);

    const conversation = await conversationFailure(conversation_id);
    expect(conversation.outcome).toBe("failed");
    expect(conversation.last_turn_error?.code).toBe("llm_provider_unavailable");
    expect(conversation.last_turn_error?.message).toBe(row?.failure_reason ?? undefined);
  }, 45_000);

  test("a later successful queued turn clears the recorded turn failure", async () => {
    resetMockProvider();
    const { conversation_id, mcp_task_id } = await seedConversationAndTask("recover after failure");
    await svc.recordConversationTurnFailure(queue.testDb.db, tenantId, conversation_id, {
      code: "worker_expired",
      message: "The background worker stopped before the turn finished.",
      at: new Date(getTestNow()).toISOString(),
    });
    expect((await conversationFailure(conversation_id)).outcome).toBe("failed");

    await enqueueConversationRunTurn(queue.boss, {
      tenant_id: tenantId,
      conversation_id,
      mcp_task_id,
      actor_id: userId,
      kind: "start",
    });
    await waitForTerminal(mcp_task_id);

    expect((await getMcpTask(tenantId, mcp_task_id, queue.testDb.db))?.result).toBeTruthy();
    expect((await conversationFailure(conversation_id)).last_turn_error).toBeNull();
  }, 45_000);

  test("a normal failure uses persisted task caller instead of an unverified queued actor_id", async () => {
    const created = await svc.createConversation(
      { tenant_id: tenantId, actor_id: userId, initial_message: "fail with mismatched actor" },
      queue.testDb.db,
    );
    const mcp_task_id = await insertMcpTask(
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
    const unverifiedActorId = nextUuid();
    getMockProvider().setFailure("runturn-primary", "overloaded");
    getMockProvider().setFailure("runturn-fallback", "overloaded");

    await enqueueRawConversationRunTurn(queue.boss, queue.testDb.db, {
      tenant_id: tenantId,
      conversation_id: created.conversation.id,
      mcp_task_id,
      actor_id: unverifiedActorId,
      principal: queuedPrincipal,
      kind: "start",
    });
    await waitForTerminal(mcp_task_id);

    await waitFor(
      async () => {
        const [audit] = await queue.testDb.db
          .select({ id: auditLog.id })
          .from(auditLog)
          .where(
            and(
              eq(auditLog.tenant_id, tenantId),
              eq(auditLog.action, "conversation.turn_failed"),
              eq(auditLog.resource_id, created.conversation.id),
            ),
          );
        return Boolean(audit);
      },
      { tries: 80, sleepMs: 25, label: "persisted-caller conversation.turn_failed audit row" },
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
    expect(audit?.actor_id).toBe(userId);
  }, 45_000);

  test("failure audit preserves a persisted system-account caller without a queued principal", async () => {
    const [account] = await queue.testDb.db
      .insert(systemAccounts)
      .values({
        tenant_id: tenantId,
        name: "turn-failure-system-account",
        role_id: await builtinRoleId(queue.testDb.db, "member"),
      })
      .returning({ id: systemAccounts.id });
    if (!account) throw new Error("system account missing");
    const created = await svc.createConversation(
      { tenant_id: tenantId, actor_id: null, initial_message: "fail as system account" },
      queue.testDb.db,
    );
    const mcp_task_id = await insertMcpTask(
      {
        tenant_id: tenantId,
        conversation_id: created.conversation.id,
        kind: "start",
        actor: { kind: "system_account", id: account.id },
        request_source: "mcp",
        user_message_id: created.initial_message_id,
      },
      queue.testDb.db,
    );
    await enqueueRawConversationRunTurn(queue.boss, queue.testDb.db, {
      tenant_id: tenantId,
      conversation_id: created.conversation.id,
      mcp_task_id,
      actor_id: account.id,
      principal: null,
      kind: "start",
    });
    await waitForTerminal(mcp_task_id);
    const findFailureAudit = async () => {
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
      return audit;
    };
    await waitFor(async () => Boolean(await findFailureAudit()), {
      tries: 80,
      sleepMs: 250,
      label: "system-account conversation.turn_failed audit row",
    });
    const audit = await findFailureAudit();
    expect(audit?.actor_type).toBe("system_account");
    expect(audit?.actor_id).toBe(account.id);
  }, 45_000);

  test("a missing legacy caller stays unknown and retains the MCP source", async () => {
    const created = await svc.createConversation(
      { tenant_id: tenantId, actor_id: userId, initial_message: "fail without caller" },
      queue.testDb.db,
    );
    const mcp_task_id = await insertMcpTask(
      {
        tenant_id: tenantId,
        conversation_id: created.conversation.id,
        kind: "start",
        actor: null,
        request_source: "mcp",
        user_message_id: created.initial_message_id,
      },
      queue.testDb.db,
    );
    await enqueueRawConversationRunTurn(queue.boss, queue.testDb.db, {
      tenant_id: tenantId,
      conversation_id: created.conversation.id,
      mcp_task_id,
      actor_id: null,
      kind: "start",
    });
    await waitForTerminal(mcp_task_id);

    await waitFor(
      async () => {
        const [audit] = await queue.testDb.db
          .select({ id: auditLog.id })
          .from(auditLog)
          .where(
            and(
              eq(auditLog.tenant_id, tenantId),
              eq(auditLog.action, "conversation.turn_failed"),
              eq(auditLog.resource_id, created.conversation.id),
            ),
          );
        return Boolean(audit);
      },
      { tries: 80, sleepMs: 25, label: "legacy-caller conversation.turn_failed audit row" },
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
    expect(audit?.actor_type).toBe("unknown");
    expect(audit?.actor_id).toBeNull();
    expect((audit?.metadata as { request_source?: string })?.request_source).toBe("mcp");
  }, 45_000);

  test("a provider quota error parks the turn instead of failing it — no failure_reason, job re-enqueued with startAfter", async () => {
    const { conversation_id, mcp_task_id } = await seedConversationAndTask("quota me");
    getMockProvider().setFailure("runturn-primary", "quota_exhausted");
    getMockProvider().setFailure("runturn-fallback", "quota_exhausted");

    const sends: Array<{ data: unknown; options: unknown }> = [];
    const originalSend = queue.boss.send.bind(queue.boss);
    const spy = spyOn(queue.boss, "send").mockImplementation((async (
      name: string,
      data: object,
      options?: object,
    ) => {
      if ((data as { provider_limit_parks?: number }).provider_limit_parks) {
        sends.push({ data, options });
        return (options as { id?: string } | undefined)?.id ?? null;
      }
      return await originalSend(name, data, options);
    }) as typeof queue.boss.send);
    try {
      await enqueueConversationRunTurn(queue.boss, {
        tenant_id: tenantId,
        conversation_id,
        mcp_task_id,
        actor_id: userId,
        kind: "start",
      });
      await waitFor(async () => sends.length > 0, {
        tries: 120,
        sleepMs: 250,
        label: "provider-limit park re-enqueue",
      });
    } finally {
      spy.mockRestore();
    }

    const send = sends[0]!;
    const parkedData = send.data as { provider_limit_parks?: number; mcp_task_id?: string };
    expect(parkedData.provider_limit_parks).toBe(1);
    expect(parkedData.mcp_task_id).toBe(mcp_task_id);
    const startAfter = (send.options as { startAfter?: Date }).startAfter;
    expect(startAfter).toBeInstanceOf(Date);
    expect(startAfter!.getTime()).toBeGreaterThan(getTestNow());

    const row = await getMcpTask(tenantId, mcp_task_id, queue.testDb.db);
    expect(row?.failure_reason).toBeNull();
    expect(row?.result).toBeNull();
    const store = new ConversationTaskStore({ db: queue.testDb.db, tenant_id: tenantId });
    expect((await store.getTask(mcp_task_id))?.status).toBe("working");

    const audits = await queue.testDb.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenantId),
          eq(auditLog.action, "conversation.turn_failed"),
          eq(auditLog.resource_id, conversation_id),
        ),
      );
    expect(audits).toHaveLength(0);
  }, 45_000);

  test("a job whose mcp_tasks row already has failure_reason is an idempotent no-op", async () => {
    const { conversation_id, mcp_task_id } = await seedConversationAndTask("idempotent fail");
    await setMcpTaskFailure(tenantId, mcp_task_id, "pre_seeded_failure", queue.testDb.db);

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
    expect(row?.failure_reason).toBe("pre_seeded_failure");
    const audits = await queue.testDb.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenantId),
          eq(auditLog.action, "conversation.turn_failed"),
          eq(auditLog.resource_id, conversation_id),
        ),
      );
    expect(audits).toHaveLength(0);
  }, 20_000);
});
