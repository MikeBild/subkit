import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { deriveConversationOutcome } from "../../conversations/lifecycle-view.ts";
import * as svc from "../../conversations/service/index.ts";
import { auditLog, conversations, systemAccounts, users } from "../../db/schema/index.ts";
import {
  getMcpTask,
  insertMcpTask,
  setMcpTaskCancelled,
  setMcpTaskResult,
} from "../../mcp/tasks/store.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { testEnv } from "../../test-helpers/determinism/env.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { CONVERSATION_RUN_TURN_DLQ } from "../queues.ts";
import { createQueueCtx, type QueueTestCtx } from "../tests/setup.ts";
import { ensureTestConfig } from "../tests/test-config.ts";
import { registerConversationRunTurnDlqHandler } from "./conversation-run-turn-dlq.ts";

let queue: QueueTestCtx;
let tenantId: string;
let userId: string;
const nextUuid = createDeterministicUuidFactory(0xd1e2026);

beforeAll(async () => {
  testEnv.LLM_PROVIDER = "mock";
  await ensureTestConfig();
  queue = await createQueueCtx("conversation_run_turn_dlq");
  const t = await seedTenant(queue.testDb.db, {
    slug: "t-runturn-dlq",
    display_name: "RunTurnDLQ",
  });
  tenantId = t.id;
  const [u] = await queue.testDb.db
    .insert(users)
    .values({
      tenant_id: tenantId,
      email: "rt-dlq@test.local",
      role_id: await builtinRoleId(queue.testDb.db, "admin"),
    })
    .returning();
  if (!u) throw new Error("seed user failed");
  userId = u.id;
  await registerConversationRunTurnDlqHandler({ boss: queue.boss, db: queue.testDb.db });
});

afterAll(async () => {
  await queue.cleanup();
});

async function seedConversationAndTask(
  message: string,
  actor: { kind: "user" | "system_account"; id: string } | null = { kind: "user", id: userId },
): Promise<{ conversation_id: string; mcp_task_id: string }> {
  const created = await svc.createConversation(
    { tenant_id: tenantId, actor_id: userId, initial_message: message },
    queue.testDb.db,
  );
  const taskId = await insertMcpTask(
    {
      tenant_id: tenantId,
      conversation_id: created.conversation.id,
      kind: "start",
      actor,
      request_source: "mcp",
      user_message_id: created.initial_message_id,
    },
    queue.testDb.db,
  );
  return { conversation_id: created.conversation.id, mcp_task_id: taskId };
}

async function conversationState(conversation_id: string) {
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

async function turnFailedAudits(conversation_id: string) {
  return await queue.testDb.db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, tenantId),
        eq(auditLog.action, "conversation.turn_failed"),
        eq(auditLog.resource_id, conversation_id),
      ),
    );
}

describe("conversation.run-turn.dlq consumer", () => {
  test("a dead-lettered turn records worker_expired on the conversation so its outcome is failed", async () => {
    const { conversation_id, mcp_task_id } = await seedConversationAndTask("worker expired");
    expect((await conversationState(conversation_id)).outcome).toBe("in_progress");
    const envelope = {
      tenant_id: tenantId,
      conversation_id,
      mcp_task_id,
      actor_id: userId,
      kind: "start",
    };

    await queue.boss.send(CONVERSATION_RUN_TURN_DLQ, envelope);
    await waitFor(async () => Boolean((await conversationState(conversation_id)).last_turn_error), {
      tries: 80,
      sleepMs: 250,
      label: "conversation last_turn_error",
    });

    const first = await conversationState(conversation_id);
    expect(first.outcome).toBe("failed");
    expect(first.last_turn_error?.code).toBe("worker_expired");
    expect(await turnFailedAudits(conversation_id)).toHaveLength(1);

    await queue.boss.send(CONVERSATION_RUN_TURN_DLQ, envelope);
    await waitFor(async () => true, { tries: 12, sleepMs: 250, label: "dlq redelivery window" });

    expect(await conversationState(conversation_id)).toEqual(first);
    expect(await turnFailedAudits(conversation_id)).toHaveLength(1);
  }, 30_000);

  test("a dead-lettered turn the conversation already outran keeps the later success", async () => {
    const { conversation_id, mcp_task_id } = await seedConversationAndTask("outran expiry");
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
      { conversation_id, status: "active", events: [] },
      queue.testDb.db,
    );

    await queue.boss.send(CONVERSATION_RUN_TURN_DLQ, {
      tenant_id: tenantId,
      conversation_id,
      mcp_task_id,
      actor_id: userId,
      kind: "start",
    });
    await waitFor(
      async () =>
        (await getMcpTask(tenantId, mcp_task_id, queue.testDb.db))?.failure_reason ?? null,
      { tries: 80, sleepMs: 250, label: "outran dlq failure" },
    );

    expect((await conversationState(conversation_id)).last_turn_error).toBeNull();
    expect(await turnFailedAudits(conversation_id)).toHaveLength(1);
  }, 30_000);

  test("B1: a dead-lettered job marks the non-terminal mcp_tasks row failed/worker_expired + writes the audit row", async () => {
    const { conversation_id, mcp_task_id } = await seedConversationAndTask("worker dies mid-turn");
    const before = await getMcpTask(tenantId, mcp_task_id, queue.testDb.db);
    expect(before?.result).toBeNull();
    expect(before?.failure_reason).toBeNull();

    await queue.boss.send(CONVERSATION_RUN_TURN_DLQ, {
      tenant_id: tenantId,
      conversation_id,
      mcp_task_id,
      actor_id: null,
      kind: "start",
    });

    await waitFor(
      async () => {
        const row = await getMcpTask(tenantId, mcp_task_id, queue.testDb.db);
        return Boolean(row?.failure_reason);
      },
      { tries: 80, sleepMs: 250, label: "mcp_task worker_expired" },
    );

    const row = await getMcpTask(tenantId, mcp_task_id, queue.testDb.db);
    expect(row?.failure_reason).toBe("worker_expired");
    expect(row?.result).toBeNull();

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
    expect(audits).toHaveLength(1);
    expect(audits[0]?.result).toBe("error");
    expect(audits[0]?.reason).toBe("worker_expired");
    expect(audits[0]?.actor_type).toBe("user");
    expect(audits[0]?.actor_id).toBe(userId);
    expect((audits[0]!.metadata as { mcp_task_id?: string }).mcp_task_id).toBe(mcp_task_id);
    expect((audits[0]!.metadata as { dead_lettered?: boolean }).dead_lettered).toBe(true);
    expect((audits[0]!.metadata as { request_source?: string }).request_source).toBe("mcp");
  }, 30_000);

  test("a dead-lettered job uses persisted system-account caller without principal envelope", async () => {
    const [account] = await queue.testDb.db
      .insert(systemAccounts)
      .values({
        tenant_id: tenantId,
        name: "dlq-system-account",
        role_id: await builtinRoleId(queue.testDb.db, "member"),
      })
      .returning({ id: systemAccounts.id });
    if (!account) throw new Error("system account missing");
    const { conversation_id, mcp_task_id } = await seedConversationAndTask(
      "system account dlq caller",
      { kind: "system_account", id: account.id },
    );
    await queue.boss.send(CONVERSATION_RUN_TURN_DLQ, {
      tenant_id: tenantId,
      conversation_id,
      mcp_task_id,
      actor_id: null,
      kind: "start",
    });
    await waitFor(
      async () =>
        (await getMcpTask(tenantId, mcp_task_id, queue.testDb.db))?.failure_reason ?? null,
      { tries: 80, sleepMs: 250, label: "system account dlq caller failure" },
    );
    const [audit] = await queue.testDb.db
      .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenantId),
          eq(auditLog.action, "conversation.turn_failed"),
          eq(auditLog.resource_id, conversation_id),
        ),
      );
    expect(audit).toEqual({ actor_type: "system_account", actor_id: account.id });
  }, 30_000);

  test("a dead-lettered task with no persisted caller remains unknown", async () => {
    const { conversation_id, mcp_task_id } = await seedConversationAndTask(
      "unknown dlq caller",
      null,
    );
    await queue.boss.send(CONVERSATION_RUN_TURN_DLQ, {
      tenant_id: tenantId,
      conversation_id,
      mcp_task_id,
      actor_id: userId,
      kind: "start",
    });
    await waitFor(
      async () =>
        (await getMcpTask(tenantId, mcp_task_id, queue.testDb.db))?.failure_reason ?? null,
      { tries: 80, sleepMs: 250, label: "unknown dlq caller failure" },
    );
    const [audit] = await queue.testDb.db
      .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenantId),
          eq(auditLog.action, "conversation.turn_failed"),
          eq(auditLog.resource_id, conversation_id),
        ),
      );
    expect(audit).toEqual({ actor_type: "unknown", actor_id: null });
  }, 30_000);

  test("a dead-lettered task keeps persisted caller despite a cross-tenant principal envelope", async () => {
    const { conversation_id, mcp_task_id } =
      await seedConversationAndTask("cross-tenant dlq caller");
    await queue.boss.send(CONVERSATION_RUN_TURN_DLQ, {
      tenant_id: tenantId,
      conversation_id,
      mcp_task_id,
      actor_id: userId,
      principal: {
        provider: "test",
        kind: "user",
        id: userId,
        tenant_id: nextUuid(),
        roles: ["admin"],
      },
      kind: "start",
    });
    await waitFor(
      async () =>
        (await getMcpTask(tenantId, mcp_task_id, queue.testDb.db))?.failure_reason ?? null,
      { tries: 80, sleepMs: 250, label: "cross-tenant dlq caller failure" },
    );
    const [audit] = await queue.testDb.db
      .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenantId),
          eq(auditLog.action, "conversation.turn_failed"),
          eq(auditLog.resource_id, conversation_id),
        ),
      );
    expect(audit).toEqual({ actor_type: "user", actor_id: userId });
  }, 30_000);

  test("B1: a dead-lettered job whose mcp_tasks row is already terminal is an idempotent no-op", async () => {
    const { conversation_id, mcp_task_id } = await seedConversationAndTask("already cancelled");
    await setMcpTaskCancelled(tenantId, mcp_task_id, queue.testDb.db);

    await queue.boss.send(CONVERSATION_RUN_TURN_DLQ, {
      tenant_id: tenantId,
      conversation_id,
      mcp_task_id,
      actor_id: userId,
      kind: "start",
    });

    await waitFor(async () => true, { tries: 12, sleepMs: 250, label: "dlq dequeue window" });

    const row = await getMcpTask(tenantId, mcp_task_id, queue.testDb.db);
    expect(row?.cancelled_at).toBeInstanceOf(Date);
    expect(row?.failure_reason).toBeNull();
    expect((await conversationState(conversation_id)).last_turn_error).toBeNull();
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
  }, 30_000);
});
